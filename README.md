# Tenderdesk

A responsive frontend for discovering tender opportunities, reviewing their fit, tracking RFP acquisition, and preparing technical and financial proposals.

This release implements the **browser-local frontend demo**. It runs without accounts, API keys, a database server, or model usage. All seeded organizations, tenders, rates, and claims are synthetic. Live procurement collection and AI services are not connected.

## Run locally

Requirements: Node.js 22.12+ (Node.js 24 recommended) and npm.

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite. The default is `http://localhost:5173`. No environment file is required. `npm run dev:demo` is an equivalent explicit demo entry point.

```bash
npm run typecheck
npm test
npm run build
npm run preview
```

The production build is generated in `dist/`. `npm run preview` serves that build locally; it is not a production server.

## Try the complete workflow

1. Open **Overview**, then **Opportunities**. Search, filter, sort, paginate, and bookmark opportunities. Add an opportunity or preview a CSV import before committing valid rows.
2. Open an opportunity. Inspect its fit and evidence coverage separately, make a shortlist/defer/decline decision, and record manual RFP acquisition.
3. In **Documents**, select a public or synthetic TXT, Markdown, PDF, or DOCX file. Review the extracted text. A sample is included at [`public/demo-rfp.txt`](public/demo-rfp.txt). Scanned or partially unreadable PDFs remain blocked as Needs OCR.
4. In **Requirements**, scan for keyword-based suggestions or add sourced requirements manually. Supply responses and resolve missing inputs. Suggestions are not AI analysis or a completeness guarantee.
5. Create a template draft, edit its sections, and save financial inputs. Markup, margin, contingency, and tax use decimal arithmetic. Blank rates remain unknown; optional costs are excluded from the base offer.
6. Send the current version for review. As the demo Owner, resolve blockers and attest to the exact version. Subsequent edits invalidate approval.
7. Export separate technical and financial DOCX files. Each has a native Word table of contents. In Word, update the entire TOC and all fields, save, and review pagination before external use.
8. Record a completed external submission manually. No portal purchase, message, payment, or bid submission is performed by this application.

The preloaded proposal for the second opportunity is ready to exercise review; the first includes missing information to demonstrate blockers. Use **Settings → Demo role preview** to try Owner, Editor, and Reviewer behavior. This is a role simulation, not authentication.

## Screens

| Route                           | Purpose                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `#/dashboard`                   | Pipeline snapshot, priorities, deadlines, and activity                             |
| `#/opportunities`               | Search, filters, sorting, bookmarks, manual entry, CSV import/export               |
| `#/opportunities/:id`           | Evidence, acquisition, documents, requirements, proposals, submission, and audit   |
| `#/review`                      | Opportunity decisions, missing information, source approvals, and proposal reviews |
| `#/proposals`                   | Proposal portfolio                                                                 |
| `#/proposals/:id`               | Section editing, financial calculations, reviews, approval, and Word export        |
| `#/sources` and `#/sources/:id` | Proposed/approved sources, access policy, and fixture tests                        |
| `#/knowledge`                   | Capabilities, company facts, exclusions, rates, and templates                      |
| `#/jobs`                        | Demo job states and local operational actions                                      |
| `#/notifications`               | In-app messages and read state                                                     |
| `#/settings`                    | Workspace preferences, simulated roles, backup, restore, and reset                 |
| `#/setup`                       | Demo availability and explicit connected-mode dependencies                         |

## Data and privacy

- Workspace data is persisted in IndexedDB in the current browser and origin. It is not shared between devices or users.
- File extraction occurs locally. Extracted text and its file hash are retained; original file bytes are not retained or uploaded.
- The interface does not call a model, scraper, payment provider, or procurement portal. Testing an unconnected source records a visible blocked result.
- Only public, nonpersonal, sanitized, or synthetic examples belong in this trial. The demo is not a secure production document repository.
- Settings provides validated JSON backup/restore. Backups include workspace content; handle them accordingly. Clearing browser data removes local edits unless you have a backup.
- Use one editing tab for the demo. Multi-tab conflict handling and server transactions are future backend work.

## Implementation

React, TypeScript, Vite, Tailwind CSS, Radix Dialog, React Router, Lucide, IndexedDB (`idb-keyval`), Decimal.js, Zod, Papa Parse, PDF.js, Mammoth, and `docx`. Large document libraries and route pages are loaded on demand. The PDF worker is bundled locally. Package versions and the npm lockfile are committed.

```text
src/
  components/       Shared controls, layout helpers, and opportunity table
  pages/            Route-level screens and scoped styles
  lib/              Store, fixtures, domain rules, finance, import, extraction, export
  test/             Real component journeys with in-memory IndexedDB
  types.ts          Shared frontend data contracts
  styles.css        Responsive design system and application shell
docs/
  FRONTEND_HANDOFF.md
  IMPLEMENTATION_SPEC.txt
```

## Deployment

This repository saves the frontend source; it does not create a hosting account or activate billing. For a static host such as Cloudflare Pages, use build command `npm run build`, output directory `dist`, and Node.js 24. Hash-based navigation and a relative asset base allow deployment under a subdirectory without rewrite rules. No server secret belongs in a Vite environment variable or the compiled bundle.

## Verification and remaining work

The production build, TypeScript checks, domain tests, and React component journeys are part of the handoff. Tests cover finance, role behavior, backup validation, persistent manual entry, navigation, approval invalidation, and the absence of external calls in the tested workflows. They use jsdom, not a real browser. Automated browser screenshots, live cross-browser testing, and full visual accessibility certification were not performed in this environment. Validate the built interface at desktop and mobile widths before production use.

The full project specification is retained in [`docs/IMPLEMENTATION_SPEC.txt`](docs/IMPLEMENTATION_SPEC.txt). Its backend, scheduling, authentication, model integration, immutable evidence/history, and production security requirements are **not claimed as implemented by this frontend release**. See [`docs/FRONTEND_HANDOFF.md`](docs/FRONTEND_HANDOFF.md) for the integration boundary and limitations.
