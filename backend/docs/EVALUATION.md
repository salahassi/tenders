# Pilot evaluation

Providers have been activated and actual inference is recorded in the
[implementation checklist](IMPLEMENTATION_CHECKLIST.md); this is separate from
business-quality acceptance. The October 20
[model execution plan](MODEL_EXECUTION_PLAN.md#10-p0-and-p6--real-cases-with-todays-acceptance-first)
defines E2E-01–E2E-10 and prioritizes an actual RFP-to-Word trial. At its 11:17 UTC
baseline, that trial had zero proposal versions; no complete generated artifact
or business accuracy is claimed.

The fixtures in `backend/fixtures/evaluation` are synthetic, isolated from the connected application. Automated checks cover three increasing RFP packages (3, 12 and 36 requirements), complete cited inventory, rejection of invented quotations, missing-credential questions, buyer isolation and the verified 16,698.00 financial fixture. These are deterministic contract checks, not generated model-quality scores. Human editorial effort and acceptance remain unmeasured.

## Freeze the human-labeled sample

The Owner supplies 50–100 independently labeled advertisements. Keep this data outside the public repository. A dataset is `{ "kind": "human_labeled", "examples": [...] }`. Each example has `id`, `title`, `description`, `buyer`, `reference` and `label` (`suitable`, `unsuitable` or `uncertain`); optional `opportunity_group` binds known related advertisements. Include all known duplicates. The tool also groups normalized exact matches, equal buyer/reference pairs and token-set similarity of at least 0.85. Human review of these groups remains necessary for paraphrases the deterministic rule misses.

From `backend/`, run:

```sh
npm run evaluate -- split /private/dataset.json /private/evaluation pilot-v1
```

The fixed seed creates approximately 70% development and 30% held-out examples while keeping each duplicate group intact. Group-size or conflicting-label warnings remain explicit. Use `development.json` for tuning. `holdout-inputs.json` excludes labels. Keep `split.private.json` with the Owner and do not use it for prompt tuning. The manifest records hashes, seed and group membership; preserve it before evaluating.

## Score held-out predictions

Record one prediction per held-out ID: `id`, `routing` (`recommended`, `needs_review`, `low_fit` or `excluded`) and independently audited `citation_errors` (integer, or `null` when not reviewed). Optional `notes` may explain findings. Record the provider/model and prompt/rules revision alongside the run; the CLI makes no provider requests.

```sh
npm run evaluate -- score /private/evaluation/split.private.json /private/predictions.json /private/report.json
```

The report distinguishes recommendation precision/recall from the recall of all items routed to human attention. It lists missed suitable opportunities, irrelevant recommendations, uncertain and title-only routing, citation errors and unaudited citations. Zero denominators produce unknown metrics. Wilson 95% intervals and underlying counts show small-sample uncertainty. The proposed point targets are 90% recommendation recall and 70% precision; they are not a promise or automatic approval. The Owner must review the held-out errors, citation audit, confidence limitations and duplicate grouping before accepting the pilot.

## Review real generated proposals

Use three sanitized RFP packages of increasing complexity when a model is deliberately activated. For each, record every mandatory requirement and its cited response or unresolved question; count unsupported company claims, commercial discrepancies, cross-client references and unsupported claims of compliance. Record actual editorial minutes and the Owner's decision. Finalization requires zero invented mandatory credentials, zero unexplained arithmetic discrepancies and zero unsupported final compliance claims. Current synthetic checks do not establish these outcomes for live model outputs.
