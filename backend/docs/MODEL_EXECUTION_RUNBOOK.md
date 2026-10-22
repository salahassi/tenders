# Model execution configuration and recovery

This implements P1–P5 of [the execution plan](MODEL_EXECUTION_PLAN.md).
Use [the checklist](IMPLEMENTATION_CHECKLIST.md) for deployment and acceptance
status; source implementation is not proof of successful live inference.

## Configuration

In **Settings → Models & providers**:

1. Create a connection with a provider, account/project identifier and the **name**
   of its Supabase Secret, such as `APP_MODEL_OPENAI_KEY`. Enter the secret value
   only in Supabase Secrets. A connection's account/key binding is immutable;
   create another connection for another account. Rotate the key in Secrets.
2. Add one or more models with the provider's exact identifiers. Model names,
   enabled state and supported capabilities are database records. No model-name
   pattern chooses reasoning behavior. Use the provider's capabilities for the
   actual model; ordinary JSON mode is shown as **Validated JSON**, not strict
   constrained decoding. Unsupported settings are logged and fail over.
   **Request handling** defaults to **Automatic** in **Advanced model settings**.
   The OpenAI/Gemini adapters prefer provider background processing. An explicit
   HTTP 400/422 rejection of that feature is recorded; the same model continues
   with a standard request in a fresh worker lease with its full request budget.
   This observation is scoped to the connection/model and expires after one day;
   editing the model resets it for new snapshots. No model-name rule is used.
   **Standard requests only** is an optional override, not a capability claim.
   Accepted remote IDs are always resumed, including after an override or a
   capability observation. Timeouts, quota/auth failures, unrelated schema errors
   and unstructured responses never trigger this transport retry. Standard
   requests still run in the app's background worker, with the existing bounded
   timeout and failover; providers without resumable APIs cannot promise an
   unlimited request lifetime.
3. Set the default fallback route and optional task routes. Several models on the
   same connection can appear in one route. A task may append the default route.
   Priority follows the saved order; round robin advances the saved cursor.
4. Enable task routing for new work. Existing proposal plans and accepted remote
   requests keep their executor and frozen configuration. Connections, models,
   task profiles and route revisions are frozen for an admitted job. Disabling a
   connection prevents new requests; an accepted remote request can still be
   polled under its original identity and current data permissions.
5. Configure data sharing separately under **Assessment & data sharing**.
   A key's presence does not authorize company/tender content. Revoked content
   remains excluded. Templates and a complete company library are optional for
   a draft; missing factual/commercial inputs remain visible questions.

Legacy `_NAME` values are imported once per connection. Later database edits are
preserved; rotating a key does not overwrite names. The collapsed existing
provider controls remain for legacy work. Task routing has its own admission
switch; turning it off preserves in-flight graphs and returns future work to
legacy routing. It does not cancel existing jobs or remote requests.

## Initial task profiles

| Task | Maximum output | Reasoning preference |
| --- | ---: | --- |
| Connection check | 40,000 | Minimal |
| Source reading, assessment, feedback, legacy outline, commercial planning, grounding | 40,000 | Low |
| RFP analysis, structure/detail planning, section drafting, proposal review, correction | 40,000 | Medium |

The Owner requested one 40,000 default ceiling on October 22. A ceiling is not
a target or minimum: new phases explicitly stop at complete, concise output.
Source requirements, conditions and exceptions must still be preserved. Existing
accepted remote requests retain their saved limits and exact prompt identity.
These are per-request bounds, configurable per task and capped by the configured
model capability. They are not daily token quotas. Unsupported reasoning values
resolve to the model's declared supported preference/provider default. Actual
usage, including unknown values and separately reported reasoning usage, remains
in Activity & jobs.

## Validation and resumable processing

All model operations use the canonical schema/task registry and API-family
adapters. Optional fields in strict provider schemas become required nullable
wire fields, then normalize before local domain checks. Local validation retains
constraints even when a provider offers only JSON mode.

The graph stores immutable candidate/result references and framework checkpoints,
including pending writes, in private tables. A queue lease runs a bounded phase,
then yields. Accepted remote requests are polled rather than submitted again.
Candidate caching covers a crash after result persistence but before the next
checkpoint. A crash between provider acceptance and remote-ID persistence remains
uncertain and is handled by the existing usage ledger; exactly-once external
billing is not guaranteed.

Grounding checks the full generated text, source IDs, verbatim quotations,
required coverage, company evidence and numeric literals. It prefers a different
configured model for verification; same-model verification is recorded. Semantic
support and contradiction still require model judgment and later human artifact
review. Agreement between models is not evidence. There is no claim of perfect
hallucination detection.

All fact-bearing graph tasks share one semantic-fidelity policy: preserve the
source's actor, conditions, obligation strength, exceptions, consequences,
quantities and dates while allowing faithful paraphrase or translation. Exact
evidence quotations remain separate from those paraphrases. Missing company
proof is an uncertainty; it does not weaken a known buyer requirement.

New request phases pin semantic revision 1 in the private graph result store.
Previously started phases pin revision 0 and retain their original prompt/hash,
including accepted remote IDs, unknown sends, settled responses and saved rounds.
Do not edit a pin, clear a round or reset usage to apply new instructions. The
composed prompt version in Activity identifies the policy used by new requests.
Legacy executor requests keep their original policy. Consult the checklist for
deployment and live verification status.

When a deterministic guard is corrected, validate the latest retained report
against the exact current candidate/evidence before considering recovery. Never
select an older favorable report to hide a newer contradiction. Complete quoted
atomic spans can cover a compound claim, but missing words, negation or numbers
still fail. Content-ID accounting is necessary but is not exhaustive semantic
proof; cross-unit quotation and undeclared-assertion adversarial checks remain
documented follow-up work.

An unchanged input gets at most three completed writer candidates, across all
providers, and at most two correction passes. Repeated identical findings stop
early. Each verification input has its own bounded candidate allowance.
Persistent defects retain their graph and become `MODEL_CORRECTION_EXHAUSTED` for
review. Provider/network unavailability uses automatic waiting/failover instead;
waiting does not consume completed-candidate allowance. Conservative account-wide
429 waits prevent switching sibling models merely to evade an account limit.

A received writer response consumes that allowance before local validation;
rejected completed responses can therefore exhaust it while the graph's semantic
repair counter is still zero. These counters measure different things. An
application guard defect does not authorize resetting either counter or creating
unlimited retries. Preserve paid results and their findings for audited recovery.

Graph acceptance and generation/source/probe domain commits share a database
transaction. Cancellation, evidence revisions and input eligibility remain
server-enforced. LangGraph runs inside the existing worker; it adds no queue or
hosting service. Inherited LangSmith tracing is explicitly disabled.

## Deployment and recovery

Apply additive migrations before compatible API and worker code, then publish
the frontend. The deployment workflow checks/deploys **both** functions and
verifies anonymous denial. New tables explicitly grant only required permissions;
no anonymous Data API grant is introduced. Graph recovery views have no browser
or service-role table grants; Owner-only backup RPCs access them.

A connected Supabase release can apply the reviewed migrations and deploy both
functions without an additional application secret. The optional manual
**Deploy Supabase API and worker** workflow requires the repository
Actions secret `SUPABASE_ACCESS_TOKEN`. Its optional `apply_model_release` input
applies only the five reviewed October 20 migrations, after tests pass and before
either function is deployed. The release runner reads migration history, skips
completed migrations by name (connector timestamps can differ), and resumes the
recorded graph-storage/RPC/domain-commit boundaries without recreating existing
tables or completed functions. All three recorded parts count as a completed
graph migration; inconsistent partial history stops before DDL. Each
remaining DDL transaction records its history atomically. An unknown HTTP outcome
stops the run; a subsequent run rechecks history before doing any work. It does not
reset a database, modify existing originals or enable model admission.

The schema compatibility check blocks deployment if the v2 claim and graph-store
functions or automatic-transport observation RPC are absent. Keep the frontend release behind successful backend
deployment. A missing credential or incomplete migration is a release blocker,
not a reason to deploy the frontend or enable the new executor early.

The old `claim_backend_job()` excludes executor-2 work. New workers call
`claim_backend_job_v2()` and can drain either executor. An expired graph lease
becomes resumable waiting. This allows overlap during deployment without an old
worker interpreting a new checkpoint.

For rollback, disable new-work admission, retain the expanded schema and keep a
compatible worker available to finish existing graphs. A pre-graph worker can
process legacy jobs only; it cannot finish graph jobs. Do not drop tables, reset
usage, clear provider cooldowns or replay unknown external calls.

Workspace backup includes connection/model/routes, admission state and private
graph checkpoints/results via hashed recovery aliases. Restore into an isolated
compatible target; restored models/admission are disabled and active jobs are
canceled for review. Original documents and approvals retain the established
recovery behavior. Unreferenced committed graph history follows workspace
retention; referenced generation evidence and unresolved graphs are retained.

## Paid-model acceptance

Once the implementation release is ready, the Owner adds the paid keys and exact
model names/capabilities. Run MAIN-01–14 and E2E-01–10 from the execution plan from
fresh inputs. Isolated HTTP/provider fixtures exercise fault paths without
causing production outages. Live inference, actual RFP fidelity, Word download,
page inspection and business approval are separate acceptance evidence. A local
pipeline fixture or successful connection probe does not satisfy those gates.

## Hierarchical proposal planning (workflow 3)

The configured proposal-planning route serves both internal planning tasks.
`plan_structure` creates one compact map of requirements to sections and records
shared decisions once. `plan_blueprint` details saved section groups; it must
retain section identity, ownership and decisions. Groups follow whole subjects
and actual requirement-projection size. All original requirement text remains
available; the grouping estimate does not summarize away source obligations.

The application validates one primary owner per requirement and merges accepted
detail groups into the writing blueprint. A measured truncated detail response
subdivides only that group before an unchanged failover request can be sent.
Sections split first; a single oversized subject then splits at whole requirement
IDs. Completed groups remain saved. The compact structure itself is one bounded
request; an unsplittable oversize input still requires intervention.

New graph budget policy 2 has separate allowances for three received generation
results and two received content corrections, with five writer results total.
Retries of an already-recorded receipt and polling consume no new allowance.
Existing graphs retain budget policy 1. Verification has its own existing bounded
per-group repair policy; this release does not remove that safeguard.

The service-only `upgrade_blocked_proposal_planning` RPC is an audited recovery
for a blocked workflow-2 plan with no accepted planning result or unresolved
request. It checks Owner identity, expected revision, unchanged proposal inputs
and base version. It preserves analysis and paid receipts, supersedes failed
planning and queues one workflow-3 structure. It cannot upgrade active requests,
accepted planning or changed evidence. Use only after both entrypoints support
workflow 3. Rollout admission remains separately controlled.
