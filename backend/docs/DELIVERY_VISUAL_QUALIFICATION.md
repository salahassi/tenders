# Delivery document visual qualification

The final streaming renderer and strict verifier produced 18 DOCX files and
91 pages with exactly the same page-image hashes as the previously inspected
matrix. All 91 footer numbers are correct and have no yellow highlight. Fresh
XML checks confirm proper native PAGE fields and no `undefined` elements.
Representative layout is preserved; native TOC page-number compatibility in
LibreOffice and actual Microsoft Word update/save remain open.

## Final renderer qualification

The frozen source is `ddd35b6e721215a891a4f06f2ef0e03798d91e50`, including the
corrected native footer, streamed tables and lazy text runs, strict field/table
validation and model-derived run allowance. Its source fingerprint is
`0cd6b465933fafe95d8e8901e538778783cb0e37aabfc38f916d390b4d75e23c`.
The [render receipt](evidence/g12-renderer-qualified-render-receipt-20261104.json),
[page receipt](evidence/g12-renderer-qualified-page-receipt-20261104.json),
[independent audit](evidence/g12-renderer-qualified-audit-20261104.json) and
[review](evidence/g12-renderer-qualified-review-20261104.json) bind source,
helpers, package lockfiles, fonts, engine and actual outputs.

The actual source validator accepted all 18 DOCX files. The 12 synthetic
snapshots, all 18 render models and all page counts match the prior reviewed
matrix. Every old and current page PNG was hashed from disk: all 91 pairs are
identical, so the prior inspection of those exact images is retained. This is
not a claim that all 91 pages were manually inspected again. The current
English and Arabic TOC pages were additionally inspected at full size; zero
pages changed and therefore no changed page remained unreviewed.

Every current footer has native begin/instruction/separate/end PAGE tokens,
each directly within a Word run and explicitly neutral-highlighted. No XML
part contains an `undefined` element. Native TOC/PAGEREF instructions,
UpdateFields and empty page-number caches are preserved. All 91 actual PDF
footer text blocks have the expected page number and zero intersecting yellow
drawings. The page geometry check finds zero text spans outside page bounds.
These checks support the explicit renderer contract; they are not full OOXML
schema validation or proof against every possible visibility style.

The actual conversion engine was LibreOfficeDev
`26.8.0.0.alpha0 2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`, with Node 24.19.0,
PyMuPDF 1.26.6 and Pillow 12.3.0. Receipts include executable, harness and
bundled Amiri/Carlito hashes. Outputs are retained at
`/workspace/output/reliability-phase2-g12-qualified`. Neither the directory
name nor this representative layout result means unrestricted release
acceptance. No model, database or production calls were made.

LibreOffice still shows TOC headings and dot leaders without page-number
results in all 18 documents. The native Word update contract is preserved
without fabricated cached numbers; actual desktop/web Word update and save
have not been tested. The inherited sparse-final-page issue is unchanged.
Dense-capacity rendering, worker lifecycle, hosted storage, model semantics,
source assurance, final approval and hosted 600-second issuance remain
separate evidence categories.

## Historical footer correction evidence

The source fingerprint is
`6f2ce72b30825b7d45d109e5e7baf90f2769cedb6505dddcd7027a30980ae771`
at integrated revision `b3b1380772c099c157dc3e620f1d6c8813c28801`.
The actual renderer hash
`0c6445cf3053b32505b442720bd8a46aeb78130f09b195c2828f81ad3690526a`
exactly matches committed footer fix `fc69fef` (`90e8090` before integration).
The [fresh render receipt](evidence/g12-renderer-footer-render-receipt-20261104.json),
[page receipt](evidence/g12-renderer-footer-page-receipt-20261104.json) and
[independent visual review](evidence/g12-renderer-footer-review-20261104.json)
bind the actual outputs to that source. All payload and render-model hashes are
identical to the initial run, and all page counts remain unchanged. All 20
contact sheets were inspected again, covering every page. The PDF footer checks
also find the correct page number and zero yellow drawings in every footer.

Those historical artifacts are retained at
`/workspace/output/reliability-phase2-g12-final`; the directory name does not
mean release acceptance. Later inspection found inherited `undefined` wrappers
around that revision's PAGE tokens even though LibreOffice displayed them.
The final run above separately verifies their corrected native XML; matching
historical images are reused only as visual evidence. Ordinary-export
transport, high-density accepted payloads, concurrent renderer memory, live
storage and the issuance deadline retain their separate checks.

The footer correction deliberately preserves native TOC/PAGEREF instructions.
LibreOffice direct conversion still shows leaders without TOC page numbers.
No approximation or invented field cache is used, and actual Microsoft Word
update/save behavior has not been tested here. G12 therefore has an explicit
compatibility gap rather than an unrestricted visual pass.

## Initial result before the correction

The November 4 initial G12 review requires two field-rendering corrections.
All 18 synthetic DOCX files passed the actual `verifyExportDocx` check, and all
91 pages produced by LibreOffice were visually inspected. This is layout
evidence, not evidence that a model's response is correct or that production
delivery meets the 600-second contract.

## Initial evidence

The source fingerprint is
`93a13ac87893da6cb3e47f6479f4641158d4f0aae8c496a0979f45a6acac9b3c`.
The [render receipt](evidence/g12-renderer-before-render-receipt-20261104.json)
binds each immutable synthetic payload, actual render model and DOCX to the
source files and bundled fonts. The
[page receipt](evidence/g12-renderer-before-page-receipt-20261104.json) binds
each PDF, every page image and every contact sheet to those DOCX hashes.
The separate [visual review](evidence/g12-renderer-before-review-20261104.json)
records exactly which pages were inspected. The automatic page receipt alone
deliberately does not claim that visual review occurred.

| Renderer and language | Combined pages | Technical pages | Financial pages |
| --- | ---: | ---: | ---: |
| 1, English | 4 | 4 | 3 |
| 1, Arabic | 6 | 5 | 5 |
| 2, English | 4 | 4 | 3 |
| 2, Arabic | 6 | 5 | 5 |
| 3, English | 9 | 4 | 3 |
| 3, Arabic | 6 | 5 | 10 |

The fixtures cover all seven typed gap reasons, repeated shared sections,
combined and separate volumes, Arabic text with Latin identifiers and numbers,
zero values, a 40-row technical table, a 32-row Arabic financial table and
generated-review inline/table-cell missing-input markers. Renderer 2 also
covers the human-reviewed substantive-draft label while retaining final-
approval gaps. Synthetic provenance pins are explicitly marked as layout-only;
they do not substitute for authorized database publication.

All expected gap labels remained visible in their applicable volumes; typed
gaps and renderer-3 inline/table placeholders were yellow. Arabic shaping,
table direction, wrapped text, repeated table headers and volume separation
were legible. No clipping or overlap was observed, and the automated geometry
check found zero text spans outside page bounds. Some final pages contain only
one or two gap paragraphs; this is recorded as a minor pagination issue.

Two defects are open in this initial receipt:

1. Every TOC contains headings and dot leaders but lacks visible page-number
   results in LibreOffice. The DOCX has actual TOC/PAGEREF fields; no approximate
   page numbers should be substituted for correct field behavior.
2. Every page-number field in the footer is yellow, although page numbers are
   not missing inputs. The source footer has no explicit yellow highlight;
   conversion demonstrates an interoperability problem that structural checks
   alone did not detect.

The original artifacts are retained under
`/workspace/output/reliability-phase2-g12`. A full-page example of both defects
is `pages/v1-en-combined-combined-002.png`; all 20 labelled contact sheets are
under `contact-sheets/`. These files contain synthetic content only. A fresh
source-bound run and all-page review are required after the corrections and
final ordinary-export integration. Do not overwrite the initial evidence.

## Reproduction

Install both repository lockfiles. Use an explicitly selected source checkout
containing renderer versions 1, 2 and 3 and its installed dependencies. From the
checkout containing these scripts:

```sh
node --experimental-transform-types backend/scripts/testing/delivery_visual_fixtures.ts /absolute/source/checkout /absolute/new-output-directory
python3 backend/scripts/testing/delivery_visual_pages.py /absolute/source/checkout /absolute/new-output-directory
```

The first command calls the selected checkout's actual `buildDeliveryExport`,
`renderDocx`, strict payload validator and `verifyExportDocx`; it makes no
network, database or model calls. Source files are hashed and checked for
changes during generation. The second requires LibreOffice, Fontconfig,
`pdffonts`, Python PyMuPDF and Pillow. It uses an isolated LibreOffice profile
and font configuration with the actual Amiri/Carlito assets, saves PDF text and
font reports, and renders every page at 1.4× for inspection. Review every
contact sheet and full pages where needed before recording a visual decision.

The initial run used Node 24.19.0 and LibreOfficeDev
`26.8.0.0.alpha0 2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`.
Microsoft Word desktop/web was not available and was not tested. These
representative fixtures do not cover every allowed payload size, font engine
or customer template. Structural validation, visual qualification, model
quality, source assurance and hosted delivery acceptance remain separate gates.
