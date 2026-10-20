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
| Connection check | 1,024 | Minimal |
| Source reading, assessment, feedback, outline, commercial planning | 8,192 | Low |
| RFP analysis, section drafting, proposal review, grounding, correction | 16,384 | Medium |

These are per-request bounds, configurable per task and capped by the configured
model capability. They are not daily token quotas. Unsupported reasoning values
resolve to the model's declared supported preference/provider default. Actual
usage, including unknown values and separately reported reasoning usage, remains
in Activity & jobs.

## Validation and resumable processing

All eleven operations use the canonical schema/task registry and API-family
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

An unchanged input gets at most three completed writer candidates, across all
providers, and at most two correction passes. Repeated identical findings stop
early. Each verification input has its own bounded candidate allowance.
Persistent defects retain their graph and become `MODEL_CORRECTION_EXHAUSTED` for
review. Provider/network unavailability uses automatic waiting/failover instead;
waiting does not consume completed-candidate allowance. Conservative account-wide
429 waits prevent switching sibling models merely to evade an account limit.

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

The manual **Deploy Supabase API and worker** workflow requires the repository
Actions secret `SUPABASE_ACCESS_TOKEN`. Its optional `apply_model_release` input
applies only the four reviewed October 20 migrations, after tests pass and before
either function is deployed. The release runner reads migration history, skips
completed migrations by name (connector timestamps can differ), and resumes the
recorded graph-storage/RPC boundaries without recreating existing tables. Each
remaining DDL transaction records its history atomically. An unknown HTTP outcome
stops the run; a subsequent run rechecks history before doing any work. It does not
reset a database, modify existing originals or enable model admission.

The schema compatibility check blocks deployment if the v2 claim and graph-store
functions are absent. Keep the frontend release behind successful backend
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
