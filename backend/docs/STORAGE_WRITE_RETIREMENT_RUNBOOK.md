# Retiring uncertain Storage writes

This procedure reclaims the existing allowance for a selected write only after
old writer processes have stopped and the corresponding stored bytes have been
removed. It is a deliberate maintenance operation with a service interruption.
It does not run from the application worker, an inventory check, a release, or a
schedule. No production retirement has been performed by the implementation work.

Read [the permanent DigitalOcean access runbook](DIGITALOCEAN_ACCESS_RUNBOOK.md)
first. The only supported hosted path is the reviewed GitHub Actions workflow
with the original cluster certificate authority. Do not repeat the known failing
local direct Kubernetes route or disable certificate verification.

## Why the normal cleanup path can retain an allowance

A canceled client request does not prove that Storage stopped writing. A missing
object response does not prove that an older request cannot finish later. The
pinned Storage API writes the physical file before its final metadata transaction;
its cancellation and compensation paths therefore cannot establish settlement
from a client timeout alone.

New rendered files have a durable permission for at most one upload. A later
exact positive read can settle that write. Normal deletion of a settled object
requires a positive receipt for the exact key, object and nonmarker version. An
unknown write, a historical write without this provenance, or a lost deletion
receipt can still need this procedure. Existing cleanup rows already marked done
remain historical census entries; they do not acquire an invented quota charge.
This concerns physical file accounting, separately from a provider's unresolved
paid-model usage.

## Preconditions and reviewed input

The application must contain migrations 170442 and 172700. The exact current
Storage image must be
`docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799`.
The committed binary qualification receipt must match the selected source's
physical helper and permanent trigger function. A matching public source tag is
insufficient. The pinned binary's signed resumable-upload path bypasses its database permission
probe. The actual local test reproduced a 201 creation and 204 write after a key
was fenced. The reviewed gateway therefore denies this unused protocol on both
ports. Its exact source, immutable Nginx image, actual ConfigMap bytes and running
Pod configuration must match the qualified receipt before this helper starts.
The Storage service must remain cluster-only, with the reviewed namespace ingress
policy; alternative public Services or broadened policies reject retirement.
The ordinary object upload/download endpoints remain supported. An image,
schema, gateway, network boundary or protocol change requires fresh qualification.

Prepare one private encrypted selection using the existing private transfer
helper. Do not put workspace IDs, object keys, manifests, database credentials or
customer content in workflow inputs, repository files, public logs or public
workflow artifacts. Public inputs contain only the encrypted object's locator and
the reviewed plaintext SHA-256. The decrypted JSON has this exact shape:

```json
{
  "version": 1,
  "operation_nonce": "<new UUID, retained for all retries>",
  "actor_id": "<current authorized Owner UUID>",
  "namespace_uid": "<observed tenderdesk-dev namespace UID>",
  "binary_receipt_sha256": "<committed qualification receipt SHA-256>",
  "selection": [
    {
      "id": "<storage_write_intents.id>",
      "storage_key": "<exact private key>",
      "retirement_nonce": "<current row retirement nonce>",
      "revision": 1
    }
  ],
  "expected_workloads": {
    "worker": {"uid": "<observed UID>", "image": "<immutable image>", "replicas": 1},
    "gateway": {"uid": "<observed UID>", "image": "<immutable image>", "replicas": 1},
    "storage": {"uid": "<observed UID>", "image": "<exact qualified image>", "replicas": 1}
  }
}
```

Select 1–25 exact uncertain intent rows from one workspace. The SQL transaction
checks the current Owner's membership and active identity after taking the
workspace lock. Active file, package or restore references reject retirement.
The selection's revision is the observed integer, not the example above. Missing
or changed authority, source identity, row revision, workload, persistent volume,
protocol or file namespace fails before a release of quota.

The runner inspects the actual owner of `storage.objects` and the application
trigger function. Its existing database connection must be permitted to assume
both owners. It does not create privileged roles or change table ownership. When
needed, a temporary function EXECUTE grant permits the actual Storage owner to
create the trigger; the same transaction removes only that temporary grant. The
public trigger function has no direct browser or service-role grant. Preparation
and completion are private direct-owner functions, not PostgREST endpoints.

## Execution and evidence

Review the complete
[retirement workflow](../../.github/workflows/retire-storage-writes.yml),
[runner](../scripts/ops/retire-storage-writes.py),
[coordinator](../scripts/ops/storage-retirement/coordinator.py), and
[Kubernetes adapter](../scripts/ops/storage-retirement/kubernetes.py) at the exact
ref before dispatch. The workflow defaults to `restore-services`; select `retire`
explicitly for a reviewed retirement:

```sh
gh workflow run retire-storage-writes.yml --repo salahassi/tenders \
  --ref <reviewed-ref> -f mode=retire \
  -f selection_object=<private-encrypted-request.bundle> \
  -f selection_sha256=<reviewed-plaintext-sha256>
```

The coordinator performs these operations:

1. Check the actual cluster, namespace, immutable images, workload identities,
   replica counts, storage settings, persistent volume claim and independent
   binary qualification. Refuse an autoscaler for a selected workload.
2. Check all Storage object versions and all known application keys for physical
   namespace collisions before preparing the permanent fence. Include uncertain
   keys whose metadata is absent, and both multipart metadata tables. Repeat the
   census after preparation and after writers stop. Known aliases are rejected;
   the tool never guesses which logical key owns an ambiguous file.
3. Commit an Owner-bound selection and permanent write fence. The fence rejects
   the retired key and overlapping version/sidecar namespaces before later writes
   can reach the physical upload path. Its records have no workspace or artifact
   foreign key and are not removed by tenant purge.
4. Preserve the original worker, gateway and Storage specifications and durably
   record every original Pod identity and exact container name/ID map. Read that
   journal back before protecting Pods or stopping workloads. Add a nonce
   finalizer to each observed old Pod, then set those three Deployments to zero
   with checks for unique ID and resource version. Require both the current
   container status and termination record to name the captured container.
   Accept only `Completed`, `Error` or `OOMKilled`, with valid ordered start/finish
   times and an integer exit code from 0 through 255. `NodeLost`,
   `ContainerStatusUnknown`, a missing inner container ID, an epoch timestamp or
   a different container never proves exit. Replica zero,
   Pod disappearance, a client timeout or elapsed grace time alone is insufficient.
5. Confirm that no unobserved process mounts the same persistent volume. Mount the
   exact claim in a temporary Pod using the qualified image and the old Storage
   node. The file helper follows directory file descriptors, rejects symbolic or
   multiple hard links and unsupported entries, hashes the complete bounded file
   set, checks it again before unlinking, and synchronizes the containing
   directories. It scans both qualified version layouts. Bounds are failures,
   never permission to truncate the census.
6. With all writers still stopped, remove only the exact selected metadata under
   the observed Storage table owner using the pinned server's transaction-local
   direct-delete guard. Reject multipart state. Verify both metadata and physical
   files are absent again, then submit the bound receipt to the private SQL
   completion function. The function checks the same actor, scope, nonce, fence,
   file identity and references before marking existing cleanup rows done.
7. Restore each original replica count independently and wait for workload rollout.
   Before removing any original Pod finalizer, durably save the actual termination
   receipts for every original Pod in that workload and read back the exact
   complete journal. The saved proof retains the container IDs, reason, start
   and finish times, and exit code. Mixed live/terminated groups
   retain every Pod record. Later garbage collection or a lost finalizer-removal
   reply is resolved only using those saved per-Pod receipts. Remove only the
   operation's temporary Pod and proven finalizers. A failure to restore
   any service is an operational failure even if retirement already committed.

The private receipt binds the source revision, runner identity, namespace,
qualified Storage image, permanent fence definition, helper, actual terminated
processes, per-key manifests and removed byte counts. Public output contains only
fixed status codes and the encrypted private receipt's plaintext hash. No raw
private key or customer document is logged.

## Failure, retry and service recovery

A failure never automatically removes the permanent fence. Until a valid
completion commits, unresolved physical allowance remains accounted. A partial
file removal can be retried: a fresh complete census and directory synchronization
are still required before completion. No age threshold authorizes release.

Exact preparation replay with the original selection and operation nonce returns
its saved scope, including a previously completed result after a lost reply.
Reusing a fenced key under a different nonce is rejected. Completion replay must
match the saved evidence exactly. One narrow state transition is permitted while
workers are stopping: an unknown single upload can become observed with its next
revision; the key, hash, size, send time, closure state and nonce must remain the
same. Other revision changes require inspection.

The runner always attempts service restoration, and the workflow's `always()` step
retries owned restoration and client cleanup. Replica markers record the nonce,
original replica count and original specification hash in Kubernetes so recovery
does not depend on a surviving runner. If the runner itself is killed or a node
cannot prove termination, dispatch the same private selection with
`mode=restore-services`. This restores services only; it does not remove the
fence, delete files or release quota. A protected old Pod retains its finalizer
and identity until real termination is observed, even if it is still live and
has no deletion timestamp. Restoring Deployment replicas does not fence an
already queued controller deletion. A future retirement refuses any unresolved
old Pod identity. An already saved real termination receipt can resolve a Pod
that Kubernetes has since garbage-collected; mere disappearance cannot.
Recovery always uses the journal's original container IDs, rather than adopting
the IDs of a currently found Pod. Duplicate identities, extra processes, changed
container IDs and saved proofs that do not match the captured name/ID map reject
recovery. Older UID-only journals lack this evidence and are refused; operators
must not fill in missing identity from a replacement process to force acceptance.

Use the same private selection with `mode=reconcile-processes` to explicitly
finish an interrupted stop. It first restores the intended replicas, then sends
a graceful Kubernetes delete for each unresolved original Pod with both unique
ID and resource-version preconditions. It preserves the Pod's configured grace
period and finalizer, waits for actual container termination, saves the receipts,
and only then removes the old records. This mode does not delete files or release
quota. A missing original Pod without a saved exit receipt remains unresolved and
requires actual node/process reconciliation; there is no inferred timeout proof.
After services and old-process records are resolved, inspect the saved batch and
retry the original retirement if appropriate.

A changed gateway guard is not restarted as an unsafe public route. A different
workload specification, foreign marker, reused object name, changed
UID or changed persistent volume is never overwritten to make recovery appear
successful. The fixed error `STORAGE_RETIREMENT_SERVICE_RESTORATION_REQUIRED`
requires an operator to inspect that exact drift and restore the intended service.
There is no force-delete fallback. A transient cluster outage may make immediate
restoration impossible; the durable nonce markers preserve what must be restored.

## Backup, restore and proof boundaries

Tenant backup/restore creates new destination keys. It does not copy upload
permission, endpoint retirement receipts or permanent retired-key ownership. Old
keys remain fenced even if their artifact, intent, cleanup row or workspace is
later removed. A whole-cluster rollback can restore older credentials, storage
bytes and database state together; it must preserve the operational fences and qualified gateway/network boundary,
or invalidate the old upload credentials before accepting traffic. A portable tenant
restore test does not prove that whole-cluster recovery boundary.

The PostgreSQL tests prove transactional authorization, revision and accounting
behavior using explicitly synthetic process receipts. Coordinator tests prove
ordering, failure handling and compare-and-set behavior using a fake Kubernetes
adapter. The separate pinned-container tests exercise the real Storage binary,
physical paths and replay behavior. These are distinct from hosted Pod shutdown,
real persistent-volume durability, cloud maintenance execution and production
acceptance; those remain pending until a reviewed runner execution provides its
own exact receipt.

## Retained local evidence

The SQL suite passed 25 real PostgreSQL cases. The scoped Python checks passed 33
retirement/coordinator cases, 10 gateway compare-and-set cases and 12 release
boundary cases. They include actual source/receipt hash binding, current Owner
locking, unknown process retention, immediate garbage collection with lost ACKs,
graceful explicit reconciliation, failure restoration, exact gateway updates and
worker entrypoint admission. These counts refer to isolated local tests.

The independent pinned-container receipt records 14 real binary lifecycle cases
and 38 gateway route-normalization probes. The physical helper has 12 additional
filesystem tests. The direct Storage binary remains vulnerable to signed resumable
uploads: its successful qualification depends on the exact gateway denial and
cluster-only exposure checks. These proofs do not establish hosted Kubernetes
shutdown or persistent-volume behavior. The reviewed operation remains unrun in
production until a separately recorded hosted execution.

The subsequent [process-exit correction receipt](evidence/storage-retirement-exit-proof-20261104.json)
retains four actual Python red/green reproductions against merged source
`2ac0613` and 54 focused coordinator/adapter tests. The earlier implementation
accepted a valid but different container ID, a missing inner ID or an unknown
termination reason. The corrected code rejects those cases before file removal
or accounting completion and preserves strong identity proofs during recovery.
These are synthetic control-flow tests; they do not establish actual kubelet
termination or a recovery-time/recovery-point objective. The release workflow
does not invoke this manual helper, and the runtime image does not copy it.
