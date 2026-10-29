# Model execution configuration and recovery

This implements P1–P5 of [the execution plan](MODEL_EXECUTION_PLAN.md).
Use [the checklist](IMPLEMENTATION_CHECKLIST.md) for deployment and acceptance
status; source implementation is not proof of successful live inference.

## Configuration

### DigitalOcean provider credentials

On the DigitalOcean deployment, provider key values belong in this repository's **Settings → Secrets and variables → Actions**. The **Synchronize provider credentials dynamically** workflow discovers the supported provider prefixes from source and additional credential aliases from saved model connections. A custom connection alias must match `APP_MODEL_[A-Z0-9_]{1,80}_KEY` and have the same name in repository Secrets. Adding an alias or rotating its value does not require editing the workflow's provider list.

After publication on the default branch, synchronization runs every 15 minutes, on relevant source changes and through manual dispatch. GitHub schedules can be delayed; dispatch `action=sync` when immediate synchronization is needed. Each matrix job receives only its discovered key. Values reach the owned Kubernetes `tenderdesk-runtime` Secret through standard input; only stale API/worker processes reload. Existing values survive absent/empty repository bindings, so deleting a repository Secret is not automatic runtime revocation. Remove a runtime key explicitly when revocation is intended.

Synchronization preserves connection/model enablement, routing, data-sharing permissions and limits. It cannot configure a missing provider key or add support for an unimplemented provider API. The separate manual `sample` recovery action enables the saved task route, recovers one never-sent assessment and only recovers the rest after a completed sample with a persisted fit assessment. Routine synchronization never re-enables execution after the Owner disables it.

The restricted Deno runtime also sets `LANGSMITH_CONFIG_FILE` to `/app/backend/.langsmith-disabled.json`, a nonexistent file inside its already-readable application tree. The pinned LangSmith client otherwise tries home-profile discovery while constructing a local run even when tracing is disabled. Keep the explicit selector in Docker defaults and rendered runtime environments; do not widen filesystem permissions to resolve profile discovery. The `langsmith-runtime-smoke.mjs` fixture runs with the production read permissions and no network permission to verify the local wrapper and denied home access.

If fetching notice details canonically cancels an assessment with `NOTICE_DETAILS_REFRESHED`, sample acceptance follows only the anchored latest assessment for that same opportunity. Older favorable results cannot satisfy the gate. A separate guarded `retry-sample` action can resume a current never-sent `GENERATION_HANDLER_FAILED` through the canonical job retry after its technical cause is corrected. It never resets model usage, frozen inputs or candidate counters. Needs attention recovery likewise retains consent, human verification, stale-evidence and prior-send/usage cases for their applicable review.

The following legacy Supabase configuration instructions apply to a Supabase-hosted deployment; the current production worker uses the DigitalOcean credential path above.

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

## OpenRouter setup

Store `APP_MODEL_OPENROUTER_KEY` in the Kubernetes runtime secret through the deployment workflow's GitHub secret of the same name. Do not enter the key in the browser. An optional `APP_MODEL_OPENROUTER_NAME` repository variable imports an exact model identifier, such as the model ID copied from OpenRouter; alternatively create the model under Models & providers. `APP_MODEL_OPENROUTER_PROJECT` is an optional account label and defaults to `default`.

Create or enable the OpenRouter connection with credential alias `APP_MODEL_OPENROUTER_KEY`, select the exact model identifier and add it to the desired task routes. Capabilities depend on the selected model. The default uses locally validated JSON, streaming support and no background request or reasoning control. Only select stronger schema/reasoning capabilities after verifying that the selected model supports them. OpenRouter requests use `https://openrouter.ai/api/v1/chat/completions` and require the upstream endpoint to support the supplied parameters; unsupported configurations fail rather than silently dropping those parameters.

OpenRouter routes requests to upstream model providers. Review the account's upstream routing and data policies before granting content permission. Adding credentials or selecting a route does not grant permission to send documents or company evidence. Grant those permissions separately, then use the selected-provider connection check and review actual activity and reported usage. A configured badge proves credential presence, not successful inference or free usage. Free model identifiers can still have availability and rate limits.

The combined OpenRouter/QwenCloud migration must precede the updated application. The DigitalOcean deployer applies the guarded, repeatable migration after restoring the retained schema and holds application/native workloads until all database setup checks pass; existing provider order, cursor and permissions are preserved. No automatic data-sharing permission is added. Production deployment and a successful live connection check remain separate acceptance requirements.

Reference: [OpenRouter API overview](https://openrouter.ai/docs/api/reference/overview), checked October 26, 2026.

## QwenCloud Singapore setup

QwenCloud and the existing Alibaba Model Studio connection use separate endpoints and credentials. Select **QwenCloud** for a pay-as-you-go API key created in Singapore (`ap-southeast-1`). Store its value privately as `APP_MODEL_QWENCLOUD_KEY`, with optional repository variable `APP_MODEL_QWENCLOUD_NAME` for the exact model ID. Alternatively add the model under Models & providers. The credential alias is `APP_MODEL_QWENCLOUD_KEY`; keys never enter the browser.

The fixed OpenAI-compatible base URL is `https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1`; chat requests append `/chat/completions`. QwenCloud identifies the workspace through the key, so do not put a workspace ID in the hostname. The optional `APP_MODEL_QWENCLOUD_PROJECT` is an account label for local identity tracking and defaults to `ap-southeast-1`. Changing this label does not select a different region.

The existing **Qwen** (`qwen_free`) provider remains Alibaba Model Studio and continues using `APP_MODEL_QWEN_KEY`, its model name and its workspace-prefixed Alibaba endpoint. A configured Alibaba key is not reused for QwenCloud. Data-sharing permission is separate for each provider. Add QwenCloud models to the desired routes, grant the applicable evidence permissions and inspect the selected-provider probe before relying on inference. Conservative defaults disable Qwen thinking for structured JSON requests; adjust capabilities only for a model verified to support them.

This connection supports Singapore pay-as-you-go access. QwenCloud Token Plan requires its own `token-plan.maas.qwencloudapi.com` endpoint and key, and is not covered by this connection. Keys created in another region cannot be assumed to work in Singapore. No live QwenCloud inference has been verified by the implementation tests.

References: [QwenCloud regions and endpoints](https://docs.qwencloud.com/developer-guides/getting-started/regions), [API keys and key types](https://docs.qwencloud.com/api-reference/preparation/api-key), checked October 26, 2026.
