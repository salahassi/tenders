# Proposal delivery release and verification

Use the [DigitalOcean access runbook](DIGITALOCEAN_ACCESS_RUNBOOK.md) for the
established GitHub-hosted runner route. This release uses the original cluster
and database certificate authorities. Local direct Kubernetes access is not the
release route. The release coordinator owns publishing the reviewed branch and
starting the workflow.

## Freeze the reviewed source

The release manifest is intentionally absent until all intended migration and
runtime changes have been integrated. A missing manifest blocks the workflow
before credentials, images or cluster changes. After integration, use a fresh
sanitized inventory receipt containing the native schedules:

```sh
python3 backend/scripts/ops/proposal-delivery-release.py --freeze <reviewed-inventory.json>
python3 backend/scripts/ops/proposal-delivery-release.py
```

Review and commit `backend/scripts/ops/proposal-delivery-release.json` with the
final source. The manifest binds the six existing release ledger entries, the
observed routine catalog hash, all ten existing deployment images, both native
schedules, and the exact names and SHA-256 hashes of the new migrations. The
absence of canonical migration history on this deployment is explicit. The
helper does not replay the historical schema or infer a migration tip from
application source. A source change after freezing requires regenerating and
reviewing the manifest before the release.

The full release requires executor version 4. Historical delivery payloads use
renderer version 1 and executor version 3; the new authored payload uses renderer
version 2 and executor version 4. The final batch requires all 22 migrations, including durable Storage write
intents and private retirement proofs. Runtime contracts and source authority,
consistency, optical character recognition (OCR), and deadline migrations must be
present in the final batch. The final source revision must pass both packages'
lockfile installs, typechecks, tests and builds, the operations tests, and the
applicable concurrency and actual renderer checks.

The migration-before-runtime order is permitted only after a real mixed-version
queue regression proves that every newly pinned normal generation job, child,
retry and render job requires `checkpoint.minimum_worker_executor = 4`. This
worker compatibility floor is separate from the established `model_executor`
model-adapter version. Claims by old workers at versions 2 and 3 must exclude the
new jobs during the schema/runtime transition. Blocking only new local rendering
jobs is insufficient. Until that full propagation and regression exist, the
release remains blocked even when the helper's isolated tests pass.

## Run and observe the release

Before production mutation, dispatch the isolated recovery gate at the same
reviewed branch containing the frozen manifest:

```sh
gh workflow run doks-access.yml --repo salahassi/tenders --ref <reviewed-release-ref> -f mode=restore
```

This mode is separate from inventory and the older compatibility bootstrap. It
reads catalog metadata from the current application database through the same
verified runner route. The exact six-release baseline is reconstructed into a
nonce-owned database, then the frozen additive migrations run under isolated
managed roles. Only those role names are rebound; source and mapped-body hashes
are recorded. Unexpected legacy roles block the drill rather than receiving
grants. If the exact final release and its routine catalog receipt are already
deployed, the clone uses that schema and does not apply the batch again.

Captured function definitions stay private in memory and owned Kubernetes
Secrets, split into bounded chunks and verified by SHA-256 before execution.
No production business rows are copied. Genuine isolated Auth and Storage
services create two synthetic users. The first Owner saves reviewed synthetic
source evidence and a private file; the public backup functions save rows and
bytes in memory. A database/comment/fixture guard then removes only that
synthetic source workspace and its frozen table scope. Transactional trigger
restoration and rollback checks protect the fixture reset. The singleton
workspace constraint remains intact. Canonical bootstrap creates the second
Owner's new workspace, and the ordinary restore functions import the backup.

Acceptance checks retained file hashes and distinct restored paths, unchanged
historical source confirmations with new Owner revocations, cleared requirement
assurance, previous-Owner denial, idempotent replay and zero model usage. Its
small document bytes are an explicit Storage fixture; this gate does **not**
exercise the application renderer or establish 600-second delivery latency.
The result is successful only after the exact temporary database, roles,
namespace and source SQL client have been removed. Raw catalog, credentials,
user identifiers, source content and file bytes are never public artifacts.

Local validation has two distinct layers: the schema tests reconstruct actual
managed-role PGlite catalogs and assert column/RPC/row-security boundaries;
`scripts/testing/cloud_restore_postgres.py` executes the full reconstruction,
additive batch and public backup/restore in a network-isolated real PostgreSQL
container with Auth/Storage schema stubs. The cloud gate is still required for
actual HTTP authentication and stored-byte acceptance.

After the workflow exists on the default branch and the reviewed revision has
been published, the coordinator can dispatch:

```sh
gh workflow run deploy-proposal-delivery.yml --repo salahassi/tenders --ref <reviewed-release-ref>
```

The workflow is manual only and shares the production release concurrency lock.
It validates the source before obtaining short-lived runner credentials. It
builds or reuses only the runtime, frontend and native OCR images. An existing
image tagged with the same source revision is reused after checking its immutable
registry digest and source label. A registry or TLS error is not treated as proof
that the image does not exist. Dirty tracked files or a checkout revision that
differs from the declared source revision block image publication and deployment.

The database batch runs in one transaction under the existing application owner,
with bounded lock and statement waits. It compares every original column of every
existing public/private table before and after the migration, and checks existing
function, table, row-security, role and membership authority. New tables must
initially be empty, with one exact exception: `storage_write_intents` may contain
only the distinct pre-migration workspace/key census from existing delivery
artifacts, ordinary package slots and cleanup rows, including completed cleanup
rows. Each seed must be `legacy_unfenced`, revision 1, with no send authorization,
expected hash/size, observation, closure or retirement evidence. Missing, extra
or forged seeds fail the entire transaction. Generated row/nonce identities and
creation timestamps do not certify physical bytes or release quota. Both private
retirement tables remain empty, and their helpers receive no direct API grants.
The migration does not install a trigger on the managed Storage table; the
separately reviewed Storage-owner procedure handles that authority. Adding a
column does not falsely count as rewriting saved content. The release records
both its manifest hash and resulting routine catalog hash in the existing private release ledger. A repeated invocation verifies these
receipts; it does not replay data updates, reactivate historical work or reset
unknown provider usage.

Workload updates follow the schema commit. The worker switches through its owned
`Recreate` strategy and the helper waits for the old processes to leave before
updating the application programming interface (API), source gateway and
scheduler. The existing native OCR CronJob receives its new immutable image after
the gateway supports its requests. The frontend follows. Images change through
Kubernetes JSON patches that check the current resource identity, version and
prior image. Other workload specifications, secrets, configuration and schedules
must stay unchanged. No second native OCR schedule is created.

The SQL transaction is atomic. The workload rollout is a sequence of checked
steps. A lost acknowledgement or later failure therefore requires forward
completion with the same source revision and immutable candidate images. The
helper never automatically restores old code after new durable version pins may
exist. Its private nonce-bound cleanup journal permits the unconditional final
step to remove only this attempt's temporary database client and credential
Secret. Cleanup failure prevents a success result.

## Acceptance evidence remains separate

A successful release proves the frozen SQL receipts, image identities, workload
readiness, old-worker drain, configuration preservation, public health and
anonymous access boundary. It does not by itself prove that a customer's file
was issued, that the new native OCR binary completed a real job, or that an
isolated cloud restore succeeded. Existing native jobs may finish with their
previous image; the first new scheduled job must be observed separately.

The user acceptance requirement is issuance or a clear terminal error within
600 seconds from request acceptance, including time waiting in the queue,
generation, correction and rendering. If all model agents are unavailable, the
request must return an error immediately; it must not consume the entire deadline
waiting for a human or restart a fresh deadline at each stage. The deadline
migration and its clock/failure tests are a separate implementation dependency.
A successful deployment does not certify that requirement without the actual
accepted-request and ready/error timestamps.

Read-only inventory reports queue class counts, due age, expired leases, reserved
file bytes and aggregate workspace capacity. Its
`terminal_row_elapsed_p95_seconds` is creation-to-last-update time for successful
job rows in the observed 24-hour window. It is not a first-file latency metric or
proof of the 600-second requirement. Capture canonical request acceptance,
terminal outcome and verified file availability separately. Preserve unknown
usage and ambiguous uploads while testing deadline expiry.

Hosted acceptance must also verify real authenticated downloads, source or
membership revocation, the required complete volume set, yellow placeholders,
and explicit restore retry without rewriting ready bytes. Isolated cloud restore
must use an explicitly isolated target with private data handling and verified
cleanup. Neither synthetic production workspaces nor unchanged historical model
jobs may be created or resumed merely to make a release test pass. Record each
remaining gate as open until its own evidence exists.
