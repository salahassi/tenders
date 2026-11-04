# Initial reserve request adapters

This is a bounded follow-up to [the qualification reserve](QUALIFICATION_RESERVE.md).
It constructs ten of the 50 frozen cases through existing production request helpers.
Forty cases remain explicitly unsupported; no case is silently dropped and the
100-per-model schedule is unchanged. This is offline request/validation evidence,
not model qualification, authenticated database admission or a live campaign.

| Frozen cases | Constructible | Actual boundary |
| --- | ---: | --- |
| `analyze_chunk.retention_exception`, English/Arabic | 2 | `generation.taskInput`, current exact source-span contract, `validateGenerationResult` and production semantic prompt pin. |
| `summarize_review.advisory_note`, English/Arabic | 2 | One UUID-identified review segment, canonical `general/general` review target, current task input and validation. |
| Both `inspect_source_page` scenarios, English/Arabic | 4 | Actual `automaticSources` page/link projection and `sourceReadingPrompt`; complete mode restrictions tested through `executeModel`. |
| `connection_probe.transport_identity`, English/Arabic | 2 | Empty context/evidence and canonical ready schema; protocol only. |
| All remaining cases | 40 | Explicit reasons below; no fabricated prerequisite outputs. |

The new helper is [`reserve-adapters.ts`](../scripts/qualification/reserve-adapters.ts).
`reserveAdapterCoverage()` enumerates every case and reason. `buildReserveAdapter(id)`
throws for unsupported cases. It loads the hashed corpus, strips oracle/family/scenario
labels before construction, and records an explicit original-to-canonical source map.
The corpus and source meanings are unchanged.

## Source, authority and request identity

Analysis keeps original text, content hash and Unicode code-point ranges. Canonical
span identifiers use the production helper and are resolved against the exact source
block. Review aliases map explicitly to their frozen entity UUIDs; original corpus
identities remain in the trace. Source pages map their immutable source to `page` and
retain exact `L1`–`L3` links. An opaque synthetic page URL discloses no scenario label;
no page is fetched. Page snapshot hashes are synthetic input bindings, not server
attestations or evidence of database authorization.

The generation envelope is an in-memory synthetic fixture: empty administrative
opportunity context and template, no extra buyer facts, no company evidence, and no
accepted stage outputs. Review notes use the existing `general/general` convention,
validated against `review.save` input schema. This does not assert a real proposal
version or authenticated review-save operation. Source-authority records mirror the
frozen synthetic roles, while human semantic review records remain empty. Model
confirmation flags cannot create such a review.

Production `pinSemanticPrompt` runs against a deliberately new/unstarted in-memory
phase. The adapter is not a historical replay or a migration of paid requests.
`compileReserveRequest(adapter, explicitConfiguration)` rebuilds the source adapter
and rejects any changed context, evidence, IDs, manifest or phase pins. It calls
production `executeModel` only through `requestPrepared`, then stops before
`beforeSend`, reservation or network fetch. Every forbidden operation fails closed.
No default real provider, identity, configuration or access credential is supplied.
The eventual runner must rebuild the adapter and use its actual `domainValidate`
closure; request compilation does not qualify a caller-replaced validation function.

The returned request contains the actual canonical schema, versions, negotiated
profile and capabilities. Durable `input_sha256` remains the application's user/
context prompt hash. Qualification's `prompt_sha256` hashes the ordered JSON object
`{system: actualSystemInstructions, user: actualUserPrompt}` so the separate system
instruction cannot drift unnoticed. Individual system/user hashes are also retained.
Future activation must still pin the actual source commit, adapter/validator code,
configuration and schema hashes and independently capture provider-reported identity.

The page worker uses Arabic request metadata for both page languages. The adapter
retains that production behavior while recording the case's source language separately.
The source-reading prompt preserves source quotations; this metadata does not claim
that the output language can be selected through a new instruction.

## Explicit unsupported prerequisites

- Four analysis/review cells require a composite orchestration: production processing
  selects one immutable block or review segment per request. Do not concatenate two
  source identities or hide extra calls inside the frozen single-call slot. A future
  reviewed corpus/schedule version must retain v4 and count every actual request.
- Four classification cells need a frozen notice/attachment projection with a reverse
  source map and an explicit service-scope policy. The corpus buyer sources are RFP
  evidence; classification's canonical citations require notice evidence. No company
  scope default or source-kind promotion is invented here.
- Twenty-four planning, drafting, commercial and review cells need separately frozen
  source-bound requirement inventories and, as applicable, blueprint/draft/commercial
  prerequisite records. Logical IDs and source documents are insufficient. Such future
  fixtures may be explicit test prerequisites, never mislabeled prior model successes.
- Four verifier cells need the exact typed candidate and original task context.
  `candidate_semantics` alone is not that schema-valid candidate.
- Four repair cells need the exact failed candidate, actual diagnostics, candidate hash,
  dependency closure and canonical patch scope. `allowed_paths` alone cannot establish
  the production repair contract.

## Existing campaign integration boundary

The inspected `evaluate-ai-models.yml` / `live-model-evaluation.mjs` campaign exposes
fixed development suites, target allowlists and generation ceilings. Its fixture path
passes an empty manifest and uses `fixture.assert` to set a pass flag. Registering the
new reserve there without the complete adapter/receipt/adjudication contract would
misrepresent its provenance and semantic denominator. This change does not add a live
suite, dispatch a workflow, alter those limits or treat canonical schema acceptance
as semantic success.

## Local verification and remaining work

The focused run passed 140 tests: 69 adapter/control tests plus the existing 71
reserve-integrity tests; backend typecheck passed. Tests capture actual prepared
requests without reservation/network operations, preserve source/span/identity
bindings, reject changed pins and unsupported cases, and feed explicitly authored
in-process response bytes through actual dispatch validation. They exercise trusted
source-text materialization, model-forged review neutralization, unknown-span/coverage
rejection, review UUID mapping and source-page mode restrictions that the base
validator alone does not enforce. Controlled response bytes are not provider outputs
or semantic-quality measurements.

Independent review caught an invalid synthetic review target. The schema regression
failed before correction and passes with the existing `general/general` shape. The
final source-only reread found no remaining material blocker in this ten-case slice.
See [the execution receipt](evidence/qualification-reserve-adapters-20261104.json).

The next bounded work is to freeze and independently review missing prerequisite
fixtures/composite schedules before any model outputs, then connect complete requests
and separate judgments to the authorized campaign mechanism. Private holdout,
noncritical business thresholds, real target availability and live semantic/retrieval
qualification remain open. This adapter slice closes none of those decisions.
