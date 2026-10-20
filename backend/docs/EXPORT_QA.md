# Word export verification

For the planned real generated-artifact gates, see
[E2E-01–E2E-10 in the model execution plan](MODEL_EXECUTION_PLAN.md#10-p0-and-p6--real-cases-with-todays-acceptance-first).
The fixture evidence below does not close those live acceptance gates.

October 15, 2026. Synthetic fixtures only; no business submission or live model output.

The renderer test builds four files using the server export model and verifies their native tables, live contents fields, four embedded fonts, technical-volume price separation, and exact authorized content. A modified body must fail verification. SQL tests separately reject incorrect artifact hashes and exports/submissions whose approval is stale.

All 15 pages were rendered with LibreOffice through the document-rendering runtime and inspected as PNGs: Arabic combined final (5 pages), English combined draft (4), English technical final (3), and English financial final (3). Corrections addressed Arabic/Latin spacing, contents heading and direction, numeric table widths, translated response labels, and keeping a summary table together. Final images show legible text and complete amounts without overlap or clipped table cells. Embedded Amiri and Carlito font subsets were confirmed in the rendered PDF.

The live table of contents still requires Word to calculate its page numbers. Open Word, select all and update fields (Ctrl+A, F9 on Windows), update the entire table, inspect every page, and save before external use. This review did not use Microsoft Word and does not claim final Word pagination or that arbitrary Owner-uploaded PDFs are content-verified. The interface distinguishes reviewed PDF attestation from server-verified Word content.

Reproduce the fixture files from `frontend` with `TENDERDESK_EXPORT_QA_DIR=/tmp/tenders-export-qa npm test -- src/test/exportRenderer.test.ts`. The fixtures are entirely synthetic and are never inserted into hosted workspaces. Use the document-rendering runtime or Word to inspect all resulting pages. Font files, hashes, source and licenses are under `frontend/public/fonts`.
