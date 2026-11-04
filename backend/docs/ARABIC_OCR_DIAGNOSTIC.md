# Arabic OCR diagnostic — November 4, 2026

The existing Arabic OCR default remains unqualified. The failure is inside native
recognition: the unchanged frozen raster visibly contains all four obligations,
but the baseline TSV omits the first line entirely and damages the deadline and
prohibition words. Our TSV parser did not discard a recognized first line.
Confidence 82 and `numeric_uncertainty=false` therefore did not establish correct
source meaning.

A fixed 18-configuration diagnostic varied only raster size (1000/1500/2000),
recognition languages (`ara+eng`/`ara`) and page segmentation (3/6/11), using the
same pinned OCR image, unchanged PDF and pre-authored gold. Exactly one setting
preserved the complete gold: 1000 pixels, Arabic only, segmentation 6. It was
selected for a separate check against three independently authored Arabic/mixed
pages, frozen before recognition, and the unchanged English positive control.
No further parameter search followed.

| Input | Existing default | Selected candidate |
| --- | --- | --- |
| Original Arabic failure | Incorrect; first obligation omitted | Complete exact gold |
| Maintenance holdout | Incorrect wording | Incorrect wording and `MX-2047-B` damaged |
| Records holdout | Incorrect condition wording | `ARCHIVE-Q9` damaged |
| Sensors holdout | Incorrect delay/condition wording | `SENSOR-K3` damaged |
| Existing English control | Complete exact gold, confidence 96 | Unreadable, confidence 24 |

The candidate is rejected. The opportunity's language is a proposal preference,
not a verified language classification of each source page; it cannot safely
select Arabic-only recognition. Runtime recognition, source eligibility and
mandatory page/blank review remain unchanged. No valid page is dropped or called
an invalid RFP because recognition fails.

The native acceptance oracle now compares the complete normalized page, including
headings in the fixed holdout cases. The previous ordered-substring check could
miss added negation. The stricter oracle ignores orthographic presentation only;
it retains leading decimal punctuation, numeric separators, punctuation within
identifiers, lexical additions,
negation and order. Historical raw receipts are retained with their original
scoring; the separate adjudication applies the stronger oracle without rerunning
or altering their text. It still finds one original-case pass and zero independent
Arabic whole-page passes. The English default remains the positive control.

Reproduce diagnostics explicitly inside the pinned native OCR image, mounting the
current scripts and frozen fixtures read-only, with network disabled, 768 MiB,
one CPU, 64 PIDs and a 256 MiB temporary filesystem:

```sh
node --experimental-transform-types scripts/testing/uploadedOcrDiagnosis.ts matrix /outputs
node --experimental-transform-types scripts/testing/uploadedOcrDiagnosis.ts holdouts /outputs
```

The output directory must exist and be writable. These bounded scripts are
qualification tools and are never imported by the worker. The ordinary native
quality suite remains expected to fail Arabic while the current recognizer is
unqualified. The pure oracle regression suite does not require native OCR.

The remaining path is to qualify a different recognizer or recognition policy
against frozen independent Arabic and mixed-language pages, including conditions,
negation, numbers, layouts and blanks. Until then, use the existing authorized,
source-bound visual page correction flow. Neither confidence nor tuning this
single case provides a semantic guarantee. No external provider, customer data,
production deployment or hosted acceptance was used. This work also provides no
Microsoft Word proof; the available local LibreOffice engine cannot establish
Word update/save behavior.

Evidence: [adjudication](evidence/uploaded-ocr-adjudication-20261104.json),
[18-case raw matrix](evidence/uploaded-ocr-parameter-matrix-20261104.json),
[independent raw controls](evidence/uploaded-ocr-independent-holdouts-20261104.json),
and [frozen holdouts](../tests/backend/fixtures/uploaded-ocr-holdout/freeze.json).
