These three synthetic scanned PDFs were independently authored and visually frozen
before their first OCR run. They contain no hidden text, annotations or embedded
source files. The exact gold and PDF hashes are bound by `freeze.json`.

`generate.py` and `manifest.json` are the unchanged preparation records, including
the original local source/font paths. The generator refuses to overwrite PDFs.
The invalid first bidi-rendering attempt was excluded before OCR; only the three
PDFs listed in the freeze are acceptance inputs. Gold was unchanged during that
visual correction. Do not regenerate these files to fit recognition output.

The existing engine and the candidate selected on the separate historical failure
both fail the complete-page oracle on all three cases. The candidate also changes
each mixed English identifier. This is negative qualification evidence, not a
product fallback or a declaration that these valid documents are invalid.
