# Proposal throughput, coherence and queue fairness

Date: October 21, 2026. **Approved by the Owner; implementation in progress.**

The Owner reviewed the plan and authorized implementation. Existing production
work continues on its saved execution version. Queue improvements preserve its
leases and accepted requests; the new content workflow applies to newly admitted
plans. Implementation and acceptance evidence are recorded in the checklist.

## Relationship to the project

Extend [MODEL_EXECUTION_PLAN.md](MODEL_EXECUTION_PLAN.md): P3 (grounding and
correction), P4 (durable execution), P5 (task profiles/observability), and P6
(real acceptance). Preserve the original specification's generation/review,
queue, financial calculation and export requirements, subject to later
[Owner decisions](DECISIONS.md). Track implementation, tests, deployment and
hosted acceptance separately in [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md).

## Observed baseline

- The existing real plan has 145 extracted requirements, 17 logical chapters
  and 67 writing tasks. The writer splitter uses a fixed eight requirement IDs
  per request; a requirement may be mapped to several chapters.
- Writers receive their mapped requirements/evidence but no shared solution
  decisions or other drafted prose. Requirement-scoped reviews are not a
  complete cross-section editorial review.
- At 21:39 UTC all 67 writing tasks were complete. Through the 21:49 observation,
  the proposal's internal stage transition remained queued behind background
  work. The current queue also treats assessment `advance_plan` jobs as
  interactive work based on task type, despite their different business purpose.
- Two accepted model requests can overlap. Worker leases remain serialized.
  Increasing inference concurrency alone does not remove excess requests or
  internal scheduling delay.

The baseline is evidence of these bottlenecks, not a representative latency
percentile or a completed end-to-end benchmark.

## 1. Measure and repair scheduling first

Classify work by its owning operation and execution needs, rather than task name
alone. Keep the existing PostgreSQL queue as the execution authority:

| Work class | Scheduling behavior |
| --- | --- |
| Ready local transitions, commits and assembly | Bounded fast path; no model-request slot needed; never bypass stage dependencies or lease checks |
| Accepted remote requests | Poll only when due; retain provider/request identity and deadline-aware service without monopolizing dispatch |
| User-requested proposal work | Guaranteed share of available execution/model capacity; prioritize work that unlocks dependent proposal stages |
| Source collection and assessments | Guaranteed background share; age-based promotion prevents starvation during sustained proposal traffic |

Use weighted fair scheduling, age promotion and capacity borrowing when a class
has no eligible work. Determine initial weights from load tests; do not expose
queue internals as mandatory user setup. In-flight provider requests are not
preempted or resent to satisfy a new priority. Scope limits to the applicable
workspace and provider account/model; retain provider Retry-After.

Wake dependent work after committed completion. Keep cron as recovery. Bound
local processing by time/work allowance within the Edge invocation budget;
avoid endless draining, tight polling or sleeping through provider cooldowns.
Retain exclusive ownership per job, revision/lease validation, idempotent commits,
and protection of unknown usage. Resolve duplicate cron/wake invocations through
the same claim transaction.

Measure eligible queue wait separately from provider wait, inference, local
processing, correction and export. Distinguish inference submissions from GET
polls and scheduling continuations. Show actual stage progress and wait reasons.

The October 22 live trial additionally exposed a same-owner tie-break issue:
untouched siblings' older due times postponed verification of already-written
units. Ready saved proposal continuations now precede fresh siblings only after
class and owner fairness are applied. Future retry times and capacity still gate
eligibility. This obtains a validated unit and feedback before starting every
remaining writer, without starving other proposals or source collection.

## 2. Plan by meaning and establish shared decisions

October 22 implementation: workflow 3 first creates a compact ownership map and
shared decisions, then details groups of whole subjects. Each requirement has
one primary owner; other sections use explicit cross-references. Accepted
structure/decisions are immutable across detail groups. Their results merge
locally; original requirement wording/evidence stays available to writing and
review. A truncated group is subdivided without rerunning successful groups.

All new task profiles default to the Owner-requested 40,000 output ceiling with
explicit stop-on-completion instructions. It is not a word-count target, and
provider capability limits still apply. Separate generation/correction budgets
allow a content repair after generation failover has consumed three receipts,
while retaining a five-result aggregate bound. Existing requests and completed
work remain on their saved identity. Acceptance requires the live trial below;
local tests alone do not demonstrate a completed Word or latency reduction.


Build a versioned, structured proposal blueprint from the frozen requirement
inventory, original evidence and eligible Company Knowledge. It contains:

- RFP-required structure, proposed section purpose and boundaries.
- One primary response location per requirement, plus justified secondary links.
- Proposed architecture, interfaces, terminology, delivery assumptions and
  dependencies shared by all writers.
- Known buyer facts, verified company facts and unresolved inputs as separate
  categories. Proposed decisions are never promoted to verified facts.

Validate that every requirement has a primary location or explicit unresolved
item, and that mandatory RFP forms/structure are preserved. An RFP requiring
repeated information still receives it. Link compliance entries to substantive
responses instead of generating the same narrative again for the matrix.

Create work units around coherent sections/subsections. Merge small compatible
units; split large ones at semantic boundaries using anticipated output size,
source/context size and the configured model's capabilities. Do not replace
eight requirements with another universal fixed count. If a response is truncated,
retain completed valid units and split only the unfinished unit without dropping
requirements. Record the reason and lineage for each split.

Each writer receives the shared blueprint, its own requirements and original
evidence, and relevant interface/dependency decisions. Independent sections may
run concurrently. Dependent sections wait for the necessary saved decisions.
Produce the executive summary after the substantive solution is available.
Do not send every previous section to every writer. Source references remain
available to check facts omitted by a compact context projection.

## 3. Reduce repeated verification while preserving coverage

Keep strict structured outputs and deterministic schema, reference, coverage,
numeric and completion checks on every result. Keep Word packaging, arithmetic,
table assembly and state transitions in application code.

Use a consolidated factual verification pass over unique claims and relevant
source evidence. Every factual assertion, including claims omitted from the
writer's declared claim list, must remain covered. Store verification receipts
bound to exact claim meaning/scope, source versions and validation-policy version.
Reuse a receipt only when those inputs are unchanged; uncertain equivalence is a
cache miss. Changing company evidence, dates, conditions or negation invalidates
the affected receipt. Access revocation is rechecked before reuse.

Keep separate objectives for factual grounding, requirement fulfillment and
document-wide consistency. Avoid independently re-running all three for every
small writing fragment. Use a compact cross-section decision/coverage index to
locate contradictions and inspect the full relevant prose and original sources.
Do not rely on summaries alone to prove the document is consistent. Large
reviews use coherent bounded groups and a final cross-group reconciliation.

Review outputs contain precise findings and affected IDs/locations, rather than
rewriting the whole proposal. A correction updates the affected passage/section
and rechecks it plus impacted dependencies. Preserve the existing bounded
correction allowance across all providers; identical unresolved findings end a
loop early. Missing real facts become deduplicated questions, not invented answers.

The result is an evidence-linked coverage matrix, shared decisions, scoped
findings and editable draft. Structured JSON and model agreement do not establish
perfect factual correctness or final business approval.

## 4. Keep one retry authority and existing deployment boundaries

Continue with the existing Supabase/PostgreSQL and open-source LangGraph setup.
The DB owns scheduling/leases; LangGraph owns the saved validation/correction
path; adapters own provider payload translation. Avoid independent retry loops
in every layer multiplying paid requests.

Distinguish transient provider/network failure, invalid request construction,
invalid candidate content and missing user facts. Retry transient failures with
bounded exponential backoff/jitter and provider-specific eligibility. Correct a
deterministically invalid payload before another send; do not cycle an unchanged
bad application payload through all models. Preserve configured failover for
actual provider/model failures. Poll accepted requests rather than resubmitting.

Re-use immutable inputs and eligible saved results. Arrange stable prompt prefixes
for supported provider caching, but measure actual cache usage rather than
assuming hits. Task-specific output/reasoning profiles follow measured quality;
model names and routing remain configurable. No new global daily token quota,
external hosting requirement or paid observability service is introduced.

## 5. Rollout, tests and acceptance

1. Record current source/migrations, task profiles, checkpoints and usage baseline.
   Preserve old requests and completed content. No paid rerun of the old 67-part
   path solely to establish a comparison.
2. Implement and test scheduling independently. Exercise multiple worker
   invocations, continuously arriving background work, multiple proposals,
   saturated model capacity, future-due polling, cancellation, stale leases,
   crash/resume, provider cooldowns and repeated cron/wake delivery.
3. Implement the new blueprint, work-unit planner and shared-context contracts
   behind a versioned admission switch. Test small/large Arabic and English RFPs,
   repeated mandatory forms, missing company/template data and oversized sections.
4. Add scoped review/repair and cache invalidation tests. Include undeclared
   company claims, contradictory dates, changed obligations, unsupported prices,
   duplicate paragraphs, lost requirements and cross-section dependencies.
5. Run complete package checks and browser journeys. Release compatible schema
   and readers first; then enable the new version for one controlled real trial.
   Old paid operations retain their frozen inputs, routes and execution version.
6. On the authorized real RFP, download actual technical/financial Word files,
   inspect content and rendered pages, and report per-stage timing, request
   counts, retries, tokens and known cost. Broader quality/latency percentiles
   require additional representative cases, not one successful file.

Acceptance gates:

- No lost work, duplicate committed versions or blind resubmission of known
  accepted requests during recovery. Preserve ambiguous acceptance honestly.
- Local stage transitions are independent of model-slot saturation. Initial
  healthy-capacity queue-wait target: p95 under 10 seconds in the controlled
  scheduling load test; tune using measured runtime limits.
- Both proposal and background classes receive their configured share under
  sustained load; delayed jobs never bypass saved eligibility.
- Every mandatory requirement is accounted for with a response/evidence link or
  an explicit unresolved item. RFP-required structure is retained.
- Initial optimization target: at least 50% fewer paid writing/verification/review
  submissions on the comparable fixture, with no quality-gate regression. This
  is a target to test, not an achieved result or a fixed document-size limit.
- A complete real draft downloads, with separate volumes when required; unknown
  prices/credentials remain explicit. Final submission approval remains separate.

Roll back new-plan admission on a failed gate; continue polling and committing
existing accepted work. Do not erase graph budgets or repack an in-flight plan.

## Primary references

- [OpenAI latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization): fewer requests/output, independent parallel work, and deterministic processing where appropriate.
- [LangGraph workflow patterns](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents): structured planning, scoped workers and synthesis with shared state.
- [Microsoft background-job guidance](https://learn.microsoft.com/en-us/azure/architecture/best-practices/background-jobs): business-priority scheduling, ordered dependencies and duplicate-message handling.
- [AWS retry/backoff guidance](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/): idempotency, jitter and avoiding multiplicative retries.

These references support the design principles. The scheduling policy and
versioned work-unit strategy are deployed. October 22's real trial completed with
122 requirements, 18 logical chapters, 55 writing units and separate technical
and financial Word downloads. Corrected assembly preserves all saved prose,
places each requirement in one volume's matrix and avoids duplicating that matrix.
The new workflow is enabled for newly admitted proposals after functional browser
acceptance; existing work retains its saved workflow.

Performance acceptance remains open. The diagnostic run needed 236 settled
requests and multiple implementation repairs; neither a 50% submission reduction
nor normal end-to-end latency is established. The older 145-requirement/67-unit
plan is not a like-for-like comparison. Further receipt reuse, fewer writing and
verification requests, and consolidation of the large review/question set remain
tracked in the implementation checklist. Successful draft export does not prove
these targets, editorial readiness or final submission approval.
