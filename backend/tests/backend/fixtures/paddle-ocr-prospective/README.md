# Prospective Arabic and mixed-page gold

These six synthetic pages are authored before any PaddleOCR output. They are
fixture inputs and exact comparison rules, not recognition results or a private
human-reviewed holdout. The author had access to prior Tesseract diagnostics.
An independent agent reviews the source, semantic oracle and visible pages
before the final hash freeze; its review is recorded separately.

| Page | Intended challenge |
| --- | --- |
| `a06-01-conditional-gate` | Actor, three guards per shift, prohibition, written exception and a later prerequisite |
| `a06-02-decimal-payment` | `0.850` versus `850`, currency, zero advance, Arabic-Indic `٤٠`, and conditional `34.000` total |
| `a06-03-incident-deadline` | Site-local date/time, `(INC-B4/27)`, conditional fallback and no next-day postponement |
| `a06-04-right-column-first` | Entire right column before left column, numbered clauses and a footer stating the order |
| `a06-05-mixed-table` | Explicit right-to-left cell order, preserved row/identifier/day associations and English obligations |
| `a06-06-blank` | Uniform white page with no visible text |

`gold-manifest.json` fixes complete logical text, block order, page coordinates,
font hashes, raster size and critical quotes with code-point spans. It also
binds all seven unchanged historical pages and their original fixture sources.
The new exact-page oracle permits Unicode NFC and whitespace normalization only.
It preserves decimal punctuation, both digit systems, identifiers, bidirectional
controls, negation and order. This is a separate prospective measurement; it
does not replace the earlier NFKC oracle or reinterpret its recorded outcomes.
Critical semantic defects must also be reported against the frozen facts, rather
than treating every typographic mismatch as the same kind of error.

The existing PyMuPDF 1.26.6 fixture technique renders pinned Amiri/Carlito text
into a 1190×1684-pixel grayscale image, then places that image in a fresh PDF.
There is no text layer, font resource, embedded file, annotation or link in the
acceptance PDF. Directional markers isolate dates and identifiers during fixture
rendering only; they never repair or normalize recognizer output. MuPDF visually
anchors the Arabic paragraphs at the left side of their declared rectangles;
the Arabic glyph direction and explicit column/cell order remain as reviewed.

Two issues were corrected during independent review before any OCR: an English
interpretation incorrectly strengthened an Arabic if→then condition into an
only-if condition, and the mixed table did not visibly specify its required cell
order. The interpretation now follows the original implication. The table now
includes a visible direction instruction, also included in its exact gold.
The first authored source and render receipt remain in `review-history/`; they
are draft preparation evidence, not an additional acceptance page set.

The final `freeze.json` binds the reviewed source, oracle, generator, review,
render receipt, PDFs and previews. Never overwrite a frozen file or silently
remove an old control. Regeneration requires a fresh output directory and the
explicit authored-source hash:

```sh
python3 generate.py --gold-sha256 <frozen-gold-sha256> --output <new-directory>
python3 -m unittest test_oracle -v
```

No candidate OCR package, model or inference engine is loaded by the oracle
checks. Rendering is preparation, not a capacity benchmark. Before the eventual
13-page experiment, the exact offline dependency/model/base/harness lock,
effective configuration, resource limits, campaign deadline and cleanup must
also be frozen. The parent must allocate the native execution window. Preserve
all returned strings, polygons and scores in their original order; do not reverse
Arabic strings, reorder columns, omit low-confidence lines or repair IDs from
this gold. A finite synthetic pass would not establish universal correctness or
remove source-bound visual review. A06 remains open.
