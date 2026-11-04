# Historical recovery qualification

This record addresses G13 in the November 4 reliability closure review and the
ME-11/ME-12 recovery requirements. It qualifies specific local transitions. It
does not claim that arbitrary historical data, every provider response, or a
hosted customer recovery has been tested.

The runtime baseline is `c3f3693`, including all migrations through
`20261104160125_proposal_issuance_file_capacity.sql`. This change adds tests and
evidence only. It does not alter prompt pins, model routing, usage accounting,
provider quotas, source permissions, recovery budgets, or production data.
All records below are synthetic. Provider HTTP responses in integration tests
are controlled fixtures; no external model, payment, or storage request ran.

## New coverage at the final schema

`historicalRecoveryQualification.integration.test.ts` adds twelve cases using a
paid writer candidate, retained old verifier report, semantic instruction pin 4,
verifier instruction pins 2, writer budget 1, exhausted verifier budget 3 and
report-correction budget 1, plus a genuinely completed sibling step. The public
application command runs through the fully migrated wrapper chain.

| Scenario | Required positive or negative result |
| --- | --- |
| Proven terminal remote operation with unknown usage | Explicit job retry creates one new 600-second authorization. An earlier expired authorization remains byte-for-byte unchanged. The old provider receipt retains unknown usage. |
| Ambiguous receipt with no remote ID at the existing 15-minute boundary | Explicit retry is allowed without replacing the receipt or granting another candidate. |
| Known remote operation at both its deadline and the ambiguity boundary | Explicit retry is allowed; source and paid request identities remain unchanged. |
| One millisecond before the ambiguity boundary | Retry is refused, without a new authorization, audit transition, graph mutation, or allowance reset. |
| Known remote operation with a later deadline | Retry is refused while that operation remains active. |
| Manual routing with an otherwise proven terminal operation | The manual policy remains restrictive; automatic recovery is not applied. |
| Terminal claim with another model, another response ID, or a nonterminal finish reason | Each independent provenance fault is rejected. A purported terminal error cannot bypass the accounting guard. |
| Source hash changed or Owner membership revoked | Each authorization/source fault is rejected even when accounting recovery would otherwise be eligible. |
| Paid partial plan with the old delivery contract | Both retry routes and a new generate command on the active old plan return `PROPOSAL_CURRENT_CONTRACT_REQUIRED`. Explicit cancel followed by generate creates a current successor and one new authorization. Historical candidate/report/pins/budgets/source bytes and the completed sibling stay in the old plan. |

Every positive retry compares the complete retained graph results, checkpoints,
writes, budgets, provider receipts, attempts, source records and accepted sibling
before and after. The new request gets a distinct identity, but the old paid
input hash and context do not change. Same-key replay reproduces the same result
and deadline; changed-body replay is rejected. Executor 3 cannot claim the new
request. Every refusal compares the full existing fixture snapshot, extended to
issuance requests and delivery snapshots/artifacts, so refusal cannot secretly
queue work or authorize another deadline.

The old-contract fixture removes the later delivery/consistency fields and
recomputes its plan hash **before** any paid candidate, model receipt or completed
sibling is seeded. No test obtains a favorable outcome by rewriting paid state.
It is a source-aware historical contract, not a claim to reproduce every older
schema revision.

## Coverage of the declared recovery variants

These are distinct assertions, not an inference from the total number of tests.
Paths below are relative to `backend/tests/backend/` unless stated otherwise.

| Acceptance variant | Concrete local evidence |
| --- | --- |
| ME-11: validated automatic output with absent usage | `roundRobin.test.ts`: “accepts validated automatic output with unknown usage and never calls a count-token endpoint.” Null telemetry remains null; completion is not represented as zero usage. |
| ME-11: active remote operation and rejected polling | `continuousModel.test.ts`: rejected-poll reconciliation and canceled-request GET-only recovery; `modelCatalog.test.ts`: historical GET-only continuation. The same accepted remote identity is retrieved without a duplicate POST. |
| ME-11: before/at/after ambiguity boundary and later remote deadline | Nine `generationPlanStatus.test.ts` boundary cases at their explicit historical migration boundary, plus the new current-schema paired cases above. Five `modelCatalog.test.ts` automatic reservation cases prove fresh call identity, duplicate-call refusal and unchanged old receipts. |
| ME-11: proven terminal unknown, another eligible target and unrelated old unknown | `modelCatalog.test.ts` terminal-response/failover cases and the terminal-cross-job reservation case; `roundRobin.test.ts` terminal OpenAI to QwenCloud cases. Failed historical receipts remain unknown while the eligible alternate produces its own receipt. |
| ME-11: exhausted correction and manual routing | New paid partial-plan tests retain the exhausted verifier/report-correction budgets exactly; manual recovery is denied. Artifact delivery is a separate qualification in the generated-delivery suite, not inferred from queueing a model job. |
| ME-12: in-flight legacy formats 1/2 and old whole/batch/audit requests | `modelTypedVerificationRegistry.test.ts` compares all 43 committed historical wire hashes against baseline `d5ddad344bde81d53bbd4b8f5b2d06c6d1eb4064`. `modelTypedVerificationPhase.integration.test.ts` uses actual reserved/unknown/settled receipts and saved rounds/pins to prevent historical format upgrades. |
| ME-12: candidate 0 with an old report | `analysisVerifierRecheck.integration.test.ts` and `modelVerifierRecheck.integration.test.ts`: separate child lineage, exact retained candidate, only a new verifier/report-correction allowance, accepted sibling unchanged. |
| ME-12: candidates 1/2 after repair | `modelWriterValidationHandoff.integration.test.ts`: each exact candidate index is selected without another writer payment, accepting content, or resetting budgets. Wrong index/key/result/producer/phase/receipt are independently rejected. |
| ME-12: revoked cache, source change and altered producer | `modelVerifierRecheck.integration.test.ts` rechecks content permission and target availability before cache return; analysis recheck and writer-handoff suites reject source/producer/receipt/phase mismatches. New public retry cases prove these protections remain effective with current issuance admission. |
| ME-12: crash after seed or after retaining an attempt | `modelVerifierRecheck.integration.test.ts` resumes the saved seed without a writer call; writer-handoff cases recover running/waiting attempts; `modelBlockedRecovery.test.ts` requires matching proof after an accepted-result crash. |
| ME-12: invalid correction, newer invalid report and false pending repair | `modelInvalidVerificationRecovery.integration.test.ts`, `modelRepairRecovery.test.ts` and `modelBlockedRecovery.test.ts` reject malformed/newer-invalid reports, preserve retained results and budgets, and undo only an unstarted false schedule. |
| ME-12: paid writer continuation and alternate writer recovery | `modelWriterRecovery.test.ts` and `modelAlternateWriterRecovery.integration.test.ts` exercise real graph/database state with controlled GET responses. They preserve the original request and distinct paid candidates and re-run independent validation. |
| Current successor, with and without an accepted version | Two fresh real PostgreSQL command-integration cases run the complete migrated schema. Explicit cancel/generate and regenerate preserve old frozen context/hash, expose the correct action, and do not repin the old plan. These are command cases, not concurrency races. |
| Historical operational resume versus current admission | `scripts/ops/test_resume_requested_processing.mjs` first proves the reviewed deployed November 3 behavior. It then applies every later migration as the managed database owner and verifies both public retry routes reject that old contract without mutating any retained public/graph/request row. |

The operational fixture previously loaded all migrations while expecting the old
whole-plan accounting error. That assertion became invalid when the new contract
correctly required an explicit successor. The test now names both boundaries;
it does not weaken or bypass the current runtime guard.

## Fresh execution receipts

The focused runs on this baseline passed:

- 237 tests across eleven paid/historical recovery suites, including the twelve new cases.
- 60 tests across the typed-registry and verifier-prompt suites, including the 43 exact historical wire hashes.
- 14 selected reservation and retry-boundary tests; 114 unrelated tests in those two files were explicitly skipped.
- 17 selected provider-state/unknown-usage tests; 143 unrelated tests in those three files were explicitly skipped.
- Three operational Python tests, including the migrated database fixture.
- Two command-integration cases on isolated PostgreSQL 17.6 with networking disabled and no published ports.
- Backend TypeScript typecheck.

The 328 Vitest cases are a focused set, not the full backend suite. The two
PostgreSQL cases are recorded with every migration hash in
[`evidence/historical-current-issuance-contract-postgres-20261104.json`](evidence/historical-current-issuance-contract-postgres-20261104.json).
The execution summary, commands and local log hashes are recorded in
[`evidence/historical-recovery-qualification-20261104.json`](evidence/historical-recovery-qualification-20261104.json).

## Remaining acceptance boundaries

No hosted recovery, provider-specific real polling, production migration, or
paid historical customer request was executed. Those remain release/hosted
acceptance work. PostgreSQL command cases do not establish concurrency safety;
the separate issuance and projection race receipts cover their stated races.
A current-contract successor is intentionally a new authorization: it does not
promise to resume an old paid wire as if it were the new protocol.

Artifact issuance after correction exhaustion, every-task semantic accuracy,
OCR quality, and provider context capacity remain governed by their respective
qualification records. This matrix proves the declared local recovery transitions;
it does not turn synthetic transport fixtures or unchanged hashes into evidence
of universal semantic correctness.
