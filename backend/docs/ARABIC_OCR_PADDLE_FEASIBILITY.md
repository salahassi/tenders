# Arabic page recognition: bounded PaddleOCR feasibility proposal

The official `PP-OCRv5_mobile_det` detector and `arabic_PP-OCRv5_mobile_rec`
recognizer are a materially different candidate from the rejected Tesseract
configurations. The available evidence supports a fixed, isolated experiment.
It does not establish Arabic document correctness, compatibility with the current
resource limits, or a reason to change production defaults. A06 remains open.
Optical character recognition (OCR) converts page images to machine-readable text;
line recognition alone does not establish that all page content was found or read
in the correct order.

The [metadata and source assessment](evidence/arabic-paddle-feasibility-20261104.json)
retains official source commits, model revisions, package hashes and inspected
file hashes. No package wheel or model weight was installed, and no recognition
was run. The earlier `tessdata_best` result remains three passing controls out of
seven pages, with all four Arabic cases failing. Those results are unchanged.

## Candidate and resource constraints

Use PaddleOCR 3.7.0 and PaddleX 3.7.0 with the official PaddlePaddle 3.2.0 CPU
package for CPython 3.11 on Linux x86-64. These are candidate pins, not a resolved
or tested dependency lock. The official Arabic convenience option selects a
server detector, so the experiment must explicitly name the mobile detector and
both immutable local model directories. Avoid inherited model defaults or
network downloads during execution.

| Evidence | Concrete implication |
| --- | --- |
| Arabic recognizer and mobile detector runtime files total 13,070,333 bytes. | Model size alone does not establish working memory, initialization time or whole-page accuracy. |
| Four core wheels total 260,054,611 compressed bytes and declare 897,243,540 expanded member bytes. | This is a metadata lower bound before transitive packages, interpreter, model files, caches and container layers. It is not measured installation size. |
| The observed OCR workload limit is 768 MiB and one CPU; an uploaded-page attempt has a 90-second bound and raster size at most 2,000 pixels per side. | The full candidate, including its Node parent, must be measured inside those existing limits. No resource increase is assumed. |
| The research observed about 1.9 GiB of free workspace disk. | A clean build is not yet shown to fit. The separate `/tmp` filesystem is memory-backed and cannot substitute for a disk-backed capacity measurement. |
| Official Arabic results report 81.27% whole-line correctness on vendor evaluation data; Arabic CPU timing cells are absent. | That metric does not establish proposal accuracy, page recall or performance on this workload. General published timings use eight CPU threads and exclude pre/postprocessing. |

The dependency lock must include the actual OCR-core extras and unconditional
PaddleX dependencies, including NumPy, Pandas, image/PDF libraries, model-client
libraries and the bidirectional-text library. The four-wheel lower bound is not
permission to omit required dependencies or substitute a converted inference
engine. Native-library compatibility and startup remain untested.

## Arabic reading-order risk

The inspected PaddleX runner applies `python-bidi.get_display` to recognized Arabic
lines. Its standard quadrilateral box sorter orders boxes top to bottom and then
left to right. This is explicit display handling, but it does not prove correct
logical Unicode for mixed Arabic/Latin identifiers, dates and parentheses, or the
right-column-first order of an Arabic page. The standard detector benchmark also
does not establish Arabic page detection recall.

Preserve the exact upstream returned text, polygons and scores. The returned text
has already undergone the upstream display transformation and must not be called
raw pre-transformation output. Compare its logical character and block order to
independently frozen gold. A visually plausible rendering is insufficient. Do not
reverse strings or reorder boxes to fit the expected answer after observing a
failure.

## Proposed first experiment

Before any recognizer output, a different author should prepare six new image-only
pages and a reviewer should check their exact whole-page text and order visually.
Record the font, raster dimensions, source coordinates, image hashes and the absence
of hidden PDF text. Freeze all gold, normalization rules and candidate settings.
The six pages should cover:

1. Arabic actor, prohibition, exception and a condition on a later line, using new
   wording and values.
2. Payment or budget text distinguishing a decimal quantity from an integer,
   explicit currency, zero, and Arabic-Indic and Western digits.
3. A dated incident deadline with time, a Latin identifier, slashes and parentheses.
4. A right-column-first Arabic page with numbered clauses and a footer.
5. A mixed Arabic/English table and English paragraph with technical identifiers.
6. A visually blank page, for which invented text is a failure.

Keep all seven previous pages as separately labeled development regressions. The
campaign therefore has thirteen fixed pages, not a replacement set that discards
known failures. Freeze Unicode NFC, line-ending and whitespace normalization before
execution; retain exact-page mismatches separately from critical semantic defects.
Do not silently normalize away punctuation, number order, negation or block order.

Use the pinned mobile pair on CPU with one inference thread and batch size one.
Keep the existing page raster limit, disable the extra orientation/unwarp models
for this explicitly upright typed-page candidate, and retain all detected lines
with an explicit zero recognition-score filter. Confidence is not correctness.
The tested scope will not include rotated or warped documents.

After disk/dependency preflight and a serialized native-test window are available,
first run cold initialization and the blank page offline in the existing 768 MiB,
one-CPU, no-swap, 90-second envelope. Include the actual parent wrapper in the same
control group. Stop on a resource failure and retain it. Otherwise process all
thirteen pages sequentially with the frozen per-page and campaign bounds, recording
peak memory, elapsed time, output hashes, failures, unexecuted pages and cleanup.
This coordination is within the already authorized testing scope; it introduces
no additional user-approval requirement.

Every critical obligation, negation, number, date, identifier and page order must
survive the fixed experiment. A finite pass would justify further qualification,
not a universal correctness claim or removal of source-bound visual review. A
failure must remain visible. Adoption would additionally require a versioned OCR
engine/provenance contract—the current worker names `tesseract`—and the existing
source, review, authorization and hosted acceptance checks. No such integration
is part of this metadata assessment.

## Authoritative references and review limits

The assessment binds these references to immutable revisions:

- [PaddleOCR Arabic recognition metrics and timing scope](https://github.com/PaddlePaddle/PaddleOCR/blob/b03f46425e8ff4442b268ce449e3eef758146cd4/docs/version3.x/module_usage/text_recognition.en.md).
- [PaddleOCR package and OCR-core dependencies](https://github.com/PaddlePaddle/PaddleOCR/blob/b03f46425e8ff4442b268ce449e3eef758146cd4/pyproject.toml).
- [PaddleX Arabic line transformation](https://github.com/PaddlePaddle/PaddleX/blob/e0068ce0bfe75b2992e5b38d06a0393c70f887f7/paddlex/inference/models/text_recognition/predictor.py).
- [PaddleX page-box sorting](https://github.com/PaddlePaddle/PaddleX/blob/e0068ce0bfe75b2992e5b38d06a0393c70f887f7/paddlex/inference/pipelines/components/common/sort_boxes.py).
- [Official Arabic model and license](https://huggingface.co/PaddlePaddle/arabic_PP-OCRv5_mobile_rec/tree/33d91636a65dca87f5562cc48860332ae367ee1b).
- [Official mobile detector and license](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det/tree/0d63e78e2b680928f6b1747d76a08db6e645efb7).

The resumed review verified the retained source hashes and package-size arithmetic.
It made no new network, install or inference calls. An independent reviewer could
not be started because the agent-thread limit was reached; this consistency check
is an author review and does not replace independent fixture or experiment review.
