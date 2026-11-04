# G09 offline qualification

The added local coverage passes 76 paired decision-field cases across the ten
semantic primary tasks, sixteen nonrecursive boundary cases, and an independent
Arabic/English retrieval corpus. Together with the existing source, scoped-patch
and historical-wire checks, the focused run passed **183 tests in five files**.
This establishes typed visibility and the stated deterministic gates; it does not
establish that an unavailable AI model will recognize every semantic error.

The [qualification receipt](evidence/g09-offline-qualification-20261104.json)
binds source, fixture versions, first/final logs and the detailed
[typed decision results](evidence/g09-typed-decisions-20261104.json) and
[retrieval results](evidence/g09-retrieval-20261104.json). No provider calls or
production mutations occurred. Near-limit provider transport and actual-image
resource qualification have separate ownership and evidence.

## Independent oracle sequence

The JSON fixtures under
[`fixtures/g09-qualification`](../tests/backend/fixtures/g09-qualification/)
were authored before their first execution. Independent review found that the
initial blueprint repeated an already-owned requirement as its own secondary
link and attributed a cross-reference to the buyer without source text. Version
2 supplies a distinct R2 schedule unit and actual synthetic buyer wording, and
corrects reversed authority-change wording. Version 3 adds eleven independently
authored source-tuple cases, including supplier reports versus buyer accounts
and their different dates. Versions 1 and 2 remain byte-identical historical
fixtures; the receipt records every hash. The retrieval corpus remains version
1, unchanged after outcomes. Oracle labels never enter model request context.

The first execution passed 110 tests and failed sixteen source-tuple cases
because the harness omitted the required `source_evidence` envelope. The harness
now explicitly supplies an empty span/review catalog for those **transport-only**
cases. It does not fabricate authorized spans or human reviews, and it does not
call source-domain validation for those cases. This correction changes no oracle,
production guard or measured retrieval result. The first log is retained and
hashed as a harness-precondition failure, not a product regression.

## Decision-field coverage

[`modelTypedDecisionPairs.test.ts`](../tests/backend/modelTypedDecisionPairs.test.ts)
checks both values and their ownership/type through the actual whole verification
context and two disjoint content batches, including an actual `modelPrompt`
JSON serialization and parsing round-trip for each context. Candidate hashes must differ, complete
structures must reconstruct exactly, scoped content IDs must remain restricted,
and the source candidates must remain unmodified. A reference to prose outside
a batch remains a reference, not an empty value or an assertion of absence.

| Task | New pairs | Independently specified distinctions |
| --- | ---: | --- |
| `analyze_chunk` | 20 | Mandatory versus optional; null question; blocking level; separate volumes; all source-tuple groups below |
| `classify_opportunity` | 6 | Null versus zero for four ratings; critical unknown; uncertain versus out-of-scope without proof |
| `summarize_review` | 3 | Actual review identity and processed ID; advisory versus finalization |
| `plan_structure` | 4 | Volume; mode; proposed decision versus buyer fact; primary ownership |
| `plan_blueprint` | 8 | Structure fields; numeric target length; primary/secondary ownership and reason; shared decision link |
| `plan_proposal` | 3 | Volume; required ownership; question severity |
| `draft_section` | 6 | Table row/cell association; company fact declaration; source provenance; required IDs; assumption; severity |
| `plan_commercial` | 13 | Included-in-base; null/zero/positive quantity; rate; period; charge type; unit; requirement/section identities; predecessor; effort/allocation/duration |
| `review_proposal` | 6 | Answered/partial/missing/clarification; forbidden model-created NA approval; severity; requirement identity |
| `inspect_source_page` | 7 | Absent buyer/deadline/link; permitted link identity; page kind; navigation/discovery links |

The actual base-task validator rejected twenty seeded mutations. Forty other
mutations remained domain-admissible and require semantic/context review; the
tests establish their complete typed visibility, not their correctness. Sixteen
source-tuple mutations exercise transport only. No stronger domain refusal was
observed or weakened. Additional generation-context, source-currentness and
permission gates are not replaced by this base-task qualification.

The three remaining registered tasks have explicit nonrecursive checks:

- `verify_grounding`: eleven cases retain contradictory/insufficient claim and
  requirement statuses or blocking findings as defects, and reject wrong
  candidate/content/requirement identities, candidate/source quotations and
  finding ownership. A valid report is not treated as a certificate of itself.
- `repair_result`: four additional target-task cases apply the full target
  validator to nested classification, company-claim, Owner-approval and missing-
  deadline faults. The rerun
  [`modelSemanticPatch.test.ts`](../tests/backend/modelSemanticPatch.test.ts)
  separately rejects changed target/base/scope/unit identities and unauthorized
  paths, while preserving unrelated obligations and bounded dependencies.
- `connection_probe`: ready schema cannot add business-quality or another-model
  claims. The rerun
  [`modelTypedVerificationRegistry.test.ts`](../tests/backend/modelTypedVerificationRegistry.test.ts)
  retains its explicit one-target transport behavior and absence of recursive
  semantic verification. That file also revalidates all 43 frozen historical
  whole/batch/audit wire hashes and phase-aware pin behavior.

## Source-tuple authority is a separate gate

The sixteen new transport pairs cover authority role/status, modality, actor,
negation, conditions, exceptions, consequences, quantity value/unit/currency,
date value/event, span identity and review status/ID. The association fixture
keeps supplier delivery of twelve reports by November 30 distinct from buyer
provisioning of thirty-six accounts by December 31. These source facts are
synthetic and manually authored; their numeric/date ownership is not inferred
from commercial quantity fields.

The focused run also executed
[`sourceEvidence.test.ts`](../tests/backend/sourceEvidence.test.ts):

- `rejects mutation of reviewed … with indexed diagnostic` covers modality,
  actor, negation, conditions, exceptions, consequences, quantities and dates
  against an actual supplied reviewed tuple.
- `keeps bounded identifiers and exact original Unicode coordinates` checks
  source identity/extent; `normalization retains a reversible source range…`
  covers diacritics, emoji, CRLF and NBSP.
- `does not let a model self-confirm meaning or unknown authority` derives
  pending/null review state when the supplied review is absent and derives
  unconfirmed authority from an unknown source role.

Additional existing exact-authority coverage is mapped, not claimed as newly
executed in this five-file run:
[`modelSourcePatch.test.ts`](../tests/backend/modelSourcePatch.test.ts) tests
server materialization discarding forged review flags and retaining the accepted
review association; [`sourceAuthority.test.ts`](../tests/backend/sourceAuthority.test.ts)
tests the migrated publication boundary against forged authority status,
review IDs and stale source spans. Root's combined gate remains responsible for
those database/runtime tests. An empty transport catalog is never evidence that
an authority-bearing candidate would pass them.

## Independent retrieval measurement

[`companyEvidenceQualification.test.ts`](../tests/backend/companyEvidenceQualification.test.ts)
uses sixteen cross-language queries across approval workflows, cybersecurity,
integration, recovery, training, cloud operations, migration and accessibility.
Each manually specified decisive fact has a separate limiting qualification.
Six irrelevant records precede it. Whole-source controls fit in context; bounded
variants place it in a source too large for whole-source admission, with intact
paragraphs and a distant qualification. Style and unverified lookalikes are
separate negative controls.

| Metric | Observed |
| --- | ---: |
| Whole-source decisive record retained unchanged | 16/16 |
| Bounded discovery retained both fact and qualification | 9/16 |
| Bounded discovery, Arabic query / English record | 4/8 |
| Bounded discovery, English query / Arabic record | 5/8 |
| Omitted decisive evidence silently treated as complete/absent capability | 0 |
| Partial source incorrectly made claim-eligible | 0 |

The seven bounded misses are `accessibility-ar`, `accessibility-en`, `cloud-ar`,
`cloud-en`, `migration-ar`, `recovery-ar` and `recovery-en`. Every miss remains an
explicit retrieval gap. Every partial source remains unverified with exact
parent hashes/code-point spans and cannot establish a company claim through the
actual draft validator. All sixteen style/unverified controls remain excluded.
Even complete selection keeps semantic support `not_evaluated` and never proves
capability absence.

No recall target was invented after these outcomes. The predeclared gates are
exact whole-source retention, truthful omissions and no false claim eligibility;
9/16 is a measured limitation, not universal retrieval success. The corpus
qualifies source selection and safe handling of missing context. Live semantic
judgment, performance on unseen domains and configured provider/language quality
remain separate qualification work.
