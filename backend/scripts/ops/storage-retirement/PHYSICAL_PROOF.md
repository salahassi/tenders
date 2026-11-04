# Physical retirement qualification

The reviewed retirement coordinator can consume this helper's proof only after it
has fenced the selected logical key and its physical aliases, checked current
operator authority and live references, verified the exact gateway policy and
cluster-only Storage boundary, and terminated every previous writer and Storage
process. The helper does not authorize retirement or release application quota.
The database commit still requires the coordinator's exact intent, nonce, revision
and complete evidence.

`physical.mjs` uses the pinned Storage locator's `GLOBAL_S3_BUCKET/TENANT_ID/bucket/key`
layout. It includes the exact unversioned file, every UUID version under the key,
every `-$v-UUID` version, and exact UUID `.json`/`.info` sidecars. The actual pinned
TUS file store uses `.json`; this was verified with a real resumable upload. Both
separator layouts are censused even when the current setting selects one. Bare
`key.json`/`key.info`, unknown family members, symlinks, hard links and ambiguous
names fail closed. The coordinator must reject another logical key whose physical
family overlaps this one before deleting anything.

The helper opens directories through Linux file descriptors without following
symlinks. It compares the entire prior scope and manifest, rehashes each exact file
before unlinking it, checks inode/type/size/timestamps during that operation, and
fsyncs the containing directory before issuing an absence proof. Already-absent
retries also sync existing scope directories: a previous unlink may have failed
its durability barrier. An active writer can invalidate this proof; full writer
quiescence is a prerequisite, not a property inferred from a Storage HTTP status.
Any partial failure retains uncertainty and requires a new census.

Census limits are explicit: 256 files, 16,384 entries in an inspected directory,
10 MiB per file and 250 MiB total. Exceeding a limit fails without a truncated
manifest or quota release. There is no recursive directory deletion. The CLI
accepts only `inspect` or `remove`, reads private inputs at
`/run/storage-retirement/scope.json` and `expected-manifest.json`, and fixes the
physical root to `/var/lib/storage`. Canonical manifests use recursively sorted
keys and compact UTF-8 JSON; a Python cross-check verifies the hash convention.

## Actual pinned binary evidence

[The qualification receipt](../../../docs/evidence/storage-retirement-binary-20261104.json)
binds the Storage and Nginx image digests/IDs, executed binary files, exact guard
source/body, helper, harness and gateway configuration. It records 14 passing
local cases, including 38 normalized route variants across gateway ports 8080 and
8081. Synthetic credentials remain in the isolated fixture and are absent from
the committed receipt. No customer data, provider call or production operation
was involved.

A permanent database trigger rejects new ordinary uploads before an unfinished
request body is consumed. A real upload already streaming when its key was fenced
left 65,536 bytes without a metadata row after deliberately denied compensation.
The test stopped the Storage process, used the fixed-root CLI to reconcile those
bytes, deleted exact metadata as the observed Storage owner with the pinned
server's transaction-local delete authorization, and verified replay denial after
starting a fresh process. This proves why metadata absence alone is insufficient.

The original gateway and the pinned signed-TUS route produced a real failing
security condition: a pre-issued upload signature created a resumable resource
(HTTP 201) and wrote 4,096 bytes (HTTP 204) after the permanent database fence.
Signed TUS returns before the ordinary database preflight. The retained red case
is in the same receipt as the green replacement/restart proof. The upstream binary
still has this behavior when reached directly.

The current application uses ordinary Storage object APIs; the caller census is
covered by `backend/deploy/kubernetes/test_render.py`. The reviewed gateway denies
the unused upload/resumable protocol namespace on both ports. It also rejects a
residual percent escape or backslash in the first Storage protocol segment, so a
second decoder cannot turn that segment into a resumable route. Object-key
encoding remains supported. Actual encoded-slash, dot-segment, duplicate-slash,
case, double-encoding, backslash, query and suffix probes are recorded; ordinary
upload and download still return exact bytes. New gateway/Storage processes cannot
resume or recreate the retired signed-TUS resource through either gateway port.
The exact ConfigMap, running gateway revision and cluster-only Storage/network
boundary are mandatory release and retirement prerequisites.

This receipt qualifies local pinned behavior. It does not establish hosted PVC
power-loss behavior, Kubernetes termination/restore acceptance, production
throughput, canonical tenant authorization or quota-ledger correctness. Those
remain separate coordinator, PostgreSQL and hosted acceptance evidence. A whole
cluster rollback must preserve permanent endpoint retirement state or invalidate
old upload credentials before exposure; a successful tenant restore is not that
proof.

## Reproduce locally

Use the committed pinned images already present in Docker. The harness uses
`--pull never`, creates its own PostgreSQL network namespace with no external
network or published ports, and removes only its own containers.

```sh
node --test backend/scripts/ops/storage-retirement/physical.test.mjs
python3 -m unittest discover -s backend/deploy/kubernetes -p test_render.py
python3 backend/scripts/testing/storage_retirement_container.py \
  --output /tmp/storage-retirement-qualification \
  --migration backend/supabase/migrations/20261104172700_storage_write_retirement_proofs.sql \
  --gateway-before backend/scripts/ops/storage-retirement/gateway-before.conf
```

The Nginx fixture changes only namespace/upstream/DNS coordinates and uses one
worker to avoid inheriting the test host's CPU count. URI matching and rewrite
logic remain the reviewed configuration; both source and executed hashes are
recorded. The fixture installs the guard under a separate non-superuser,
`NOBYPASSRLS` application owner and installs its trigger as the observed Storage
owner using a temporary explicit execute grant, revoked immediately afterwards.
