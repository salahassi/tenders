# Semantic evaluation adjudication — November 4, 2026

The saved version 1 evaluations do not qualify any configured model for universal
semantic correctness. Their recorded results remain unchanged. An independent
offline replay identified two scoring defects, three invalid verifier reports,
and two failures caused by treating an internal category label as a factual
assertion. Correcting the scorer does not fix the invalid reports or establish
provider availability.

The evaluation used synthetic English and Arabic extraction pairs across eight
meaning dimensions. Each pair had one faithful control and one deliberate change.
It is a development corpus with one repetition, not an independent holdout or a
population accuracy estimate. No customer documents were used. This adjudication
made no live model requests and changed no provider settings or billing controls.

## Recorded results and adjudication

DeepSeek v4 Pro through QwenCloud recorded **11/16 passing English cases** and
**9/16 passing Arabic cases**. The other three configured targets did not produce
qualifying answers because of quota or credit availability. These original counts
are retained; the table explains the observed failures without relabeling the
original reports.

| Recorded case | Independent finding | Required action |
| --- | --- | --- |
| English, changed number association | The verifier correctly distinguished 36 reports from the required 12 reports. Its valid quotation included the full summary, including the unchanged buyer sentence. The version 1 scorer incorrectly required the quotation to fit only the changed sentence. | Version 2 accepts a canonical content-unit quotation containing the changed **36 reports** phrase and supporting **12 reports** source span. A bare number or unrelated buyer quotation remains insufficient. |
| Arabic, removed approval condition | The verifier explicitly identified removal of the phase-two approval condition. The version 1 explanation matcher omitted normal Arabic forms such as `يُسقط`, `يُزيل` and `غير مشروط`. | Version 2 normalizes diacritics in explanation matching and includes these forms. Exact source and candidate quotations remain unchanged and independently validated. |
| English, changed prohibition | The response detected the reversal but returned an empty `processed_requirement_ids` list. | Keep the operational failure. Do not silently insert missing identifiers. |
| English, reversed legal-retention exception | The response detected the reversal but returned no content claims. | Keep the incomplete-coverage failure. A correct observation alone is not a valid complete verifier report. |
| English, changed time unit | The response detected days becoming months but used invented finding references such as `requirement-check-0`. | Keep the invalid-reference failure. Correct the verifier report through the bounded existing correction path. |
| English faithful actor; Arabic faithful time-unit translation | Both preserved the source meaning. The verifier additionally classified the internal `deliverables` category as an unsupported tender fact. | Address the task-specific distinction between application classification metadata and narrative assertions; retain factual evidence requirements. |
| Last five Arabic cases | The provider returned HTTP 403 with quota exhaustion. No semantic answer was available. | Record these as unavailable and unscored, not semantic misses or passes. |

## Independent version 2 evaluation

`semantic_v2_en` and `semantic_v2_ar` are explicit, separately selectable suites.
Their corpus and scorer are versioned independently. The old `semantic_en` and
`semantic_ar` suites retain their frozen corpus, scorer behavior and evidence.
Version 2 keeps the same synthetic sources, candidate meaning changes and request
limits: at most four configured models and 64 generations per language suite.
Gold answers remain outside the provider prompt.

Offline regressions cover all 32 canonical controls, both saved scoring misses,
and negative examples for unrelated buyer quantities, bare numbers, wrong sources,
generic rejection, supported verdicts and wrong candidate hashes. Additional
checks require the source quantity from the affected reports clause, preserve the
version 1 scorer bytes, reject mixed-version receipts and require explicit live
activation. No version 2 live evaluation has been run. Passing these tests proves
the specified scorer behavior, not model qualification.

## Evidence integrity

The original private reports remain private. The hashes below allow an authorized
reviewer to verify the unchanged originals. The repository contains only the two
synthetic verifier outputs needed for scorer regression, without credentials,
account routing, customer records or request logs.

| Evidence | SHA-256 |
| --- | --- |
| Original English report | `cff35684dae39fa98cb5f09ade67b5372e3730efa51802b3d257142e742cb003` |
| Original Arabic report | `3281a3ee0831b35def261dd6281062a2de6b63ed30fc34d5e0ba6cb0ce72cd9a` |
| Frozen version 1 corpus | `698127390ac44cd1e1ba7c0591af7bc3668c0be2fed0cff22079dc4bdba7847b` |
| Frozen version 2 corpus | `b53d46395d713d85e3beb2ac8341cf34bc12b429cd2844a0af033288c0527d9c` |

Deployment, future live evaluation and independent holdout qualification remain
separate acceptance steps. Quota failures do not authorize billing changes or
additional live requests.
