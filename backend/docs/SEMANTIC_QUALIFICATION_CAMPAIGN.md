# Frozen proposal semantics development campaign

This is a synthetic development regression campaign, not a claim of business
accuracy, an independent private holdout, or universal correctness. It covers the
`verify_grounding` task over `analyze_chunk` candidates. The other registered tasks,
full source authority, source spans, repair composition, retrieval and operational
completion retain their separate acceptance gates in
[the acceptance specification](RELIABLE_PROPOSAL_ACCEPTANCE.md).

## Frozen before provider execution

- Corpus: [`corpus-v1.json`](../tests/backend/fixtures/semantic-qualification/corpus-v1.json).
- SHA-256: `698127390ac44cd1e1ba7c0591af7bc3668c0be2fed0cff22079dc4bdba7847b`.
- Eight paired families: optional authority, prohibition, actor, trigger,
  exception, translated day/month units, unrelated authentic numbers and
  discretionary consequences. Each has English and Arabic faithful/mutated
  controls: 32 candidates in total. Translation families stay in this one
  development split; none is presented as held out.
- The original quotes remain unchanged between each pair. The numeric case
  retains the second buyer obligation in both variants so a faithful control
  does not itself omit source content.
- Root authored gold independently of the model implementation agent. That
  agent reviewed the oracle before live outcomes and identified an overly strict
  whole-sentence quotation requirement. The corrected oracle allows canonical
  short quotations containing a predeclared changed span, with exact source
  association and a dimension-specific finding. This is a pre-execution oracle
  correction, not tuning a prompt to a measured failure.

Expected labels, finding patterns, changed spans and split metadata stay outside
the provider prompt. The harness invokes the production format pin and canonical
prompt/domain validators. Invalid candidate hashes, missing coverage and invalid
quotes cannot count as successful semantic judgments. Broad “everything is good”
or unrelated/generic objections cannot pass the mutation oracle.

## Activation and target boundary

Use the established [DO runner route](DIGITALOCEAN_ACCESS_RUNBOOK.md) and the whole
reviewed [`evaluate-ai-models.yml`](../../.github/workflows/evaluate-ai-models.yml).
The `semantic_en` and `semantic_ar` suites do nothing live unless `run_live=true`
is explicitly dispatched. A push cannot activate them.

Each suite reads all currently enabled OpenAI and QwenCloud configurations from
the existing selected workspace, binds the exact configured credential alias in
memory and refuses absent credentials, duplicate models, missing providers or
more than four targets. No model identity is fabricated or silently truncated.
The exact resolved model/capability/profile and prompt hashes are retained in the
private receipt. Provider keys, production source content and business records
are not part of the synthetic fixtures; no proposal/job/user record is created.

Per language and target, run each of the 16 cases once. There are no automatic
semantic retries or best-of selection. The campaign transport ceiling is 64
generation POSTs per language (four configured targets), 4,096 output tokens per
request, 12 continuation polls per case and the existing request/process timeouts.
These are evaluation bounds, not new product billing or daily-use policy.

## Scoring and evidence

Qualification for these exact pairs requires zero critical mutation misses and
zero faithful-control rejections. Every first failure remains in the receipt.
Transport, quota, refusal, invalid reports and interruption are `not_scored` and
leave the target unqualified; they are never a semantic pass. Unknown usage stays
unknown. A complete report must contain every unique configured target/case pair,
the frozen corpus hash and the matching suite; partial or duplicate receipts
cannot be promoted to success.

Report exact counts for each model/language/family and the full denominator;
inspect the private failed reports against their source and candidate before
changing prompts. An oracle-specific failure needs adjudication; do not rewrite
gold after seeing outcomes merely to obtain a pass. Any legitimate oracle change
requires a new corpus version/hash and preservation of the prior receipt. Record
source revision, workflow URL, prompt hashes and outcome for every new run.

The private holdout, repeat/stability sample sizes and acceptable noncritical
business-error rate in D07 remain unprovided. This development gate cannot close
those decisions or claim population confidence from 32 synthetic examples.
