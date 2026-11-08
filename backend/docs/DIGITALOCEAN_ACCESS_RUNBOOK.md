# DigitalOcean access: permanent working reference

Use this file before Kubernetes inventory, diagnosis, acceptance or deployment.
The repository-root [AGENTS.md](../../AGENTS.md) points here so the established
route is available in every checkout, without relying on conversation history.
Last reviewed: November 8, 2026.

## Proposal dispatch correction (November 8, prepared)

`deploy-proposal-dispatch.yml` and `proposal-dispatch-release.py` apply the
additive durable-timer/maintenance outbox SQL, then replace worker before
scheduler. Only these two runtime targets may change. Their baseline is
`077b06ed`; API `f573e991`, source-browser `077b06ed`, frontend `522ad1b7` and
private configuration are retained. Candidate `c6f7cce5` has a separate exact
worker/scheduler qualification from source `e2e209d`; historical API/render
qualification is not reused as evidence of the changed dispatch behavior.

Read the workflow, release helper, qualifier and schema wrapper before use.
The three-minute bound includes queue time. Schema application records its own
checksum/catalog/structure ledger without changing existing business records or
the original release manifest. Rollback drains scheduler before worker and
retains the compatible additive schema; it does not claim a schema rollback.
Native dispatch behavior and hosted readiness/authority checks are separate
from actual proposal completion. This entry is preparation, not deployment
evidence; reconcile it with the final release receipt after rollout.

## Model settings refresh correction (November 8)

`deploy-model-settings.yml` and `model-settings-release.py` are the scoped
frontend-only path for the repeated reads after catalog saves. Read both fully
before dispatch. The committed publication receipt binds the immutable image
to its exact source; all frontend/shared build inputs must match that source.
The baseline requires frontend `b2201c24`, API `f573e991` and retained runtime
`077b06ed`. Schema, model configuration and private settings remain unchanged.
The workflow checks the exact image in isolated Chromium, then real authenticated
settings startup and two accelerated status polls with same-origin GETs only.
It also compares public code assets and exercises the actual PDF worker. The
110-second coordinator reserves time for owned rollback/cleanup inside the
three-minute Actions bound. Monitor queue time too.
[Run42465497658](https://github.com/salahassi/tenders/actions/runs/42465497658)
passed at `c804cffa` in 113 seconds including queue time. Frontend is now
`522ad1b7` (artifact source `f5e4e5a`, public index SHA `7c8fe252`); API and
other runtime images are retained. Settings opened in 8.898 seconds with 37
startup reads; two accelerated polls each made one status request and no
business-history reads. Image-bound toggle tests, public assets/PDF, logout and
owned cleanup all pass. See [the final receipt](evidence/model-settings-release-passed-20261108-42465497658.json).
This one-time release is complete: its previous-image guard deliberately rejects
redispatch. Establish the current baseline before a subsequent release.

## Reopened workspace startup: API pagination completion

The owner reported that settings still did not load. Real-browser diagnosis
`42381585874` confirms one-row requests remain for opportunities, source runs
and fit assessments; the earlier job-summary result did not prove full startup.
`deploy-workspace-pagination.yml` is the bounded completion path for that defect.
It changes only API from `077b06ed` to qualified/published `f573e991`, retaining
frontend `b2201c24`, the three other runtime images, configuration and the applied
`ada21f57` schema ledger. It requires actual authenticated settings/model rendering,
settled requests and complete aggregate counts, with owned rollback and cleanup.
Both the three-minute job limit and 105-second coordinator bound apply. Read the
entire workflow and `workspace-pagination-release.py` before dispatch.
[Completion42384215963](https://github.com/salahassi/tenders/actions/runs/42384215963)
passed at `51bf7b1` in 123 seconds including queue time. Real authenticated settings
and model rendering completed in 10.335 seconds with 36 settled HTTP-200 API
requests, complete table counts and zero alerts/browser errors/model calls.
Logout and both cleanup stages passed. See
[the final receipt](evidence/workspace-pagination-release-passed-20261107-42384215963.json).
Current API is now `f573e991`; worker/source-browser/scheduler remain `077b06ed`
and frontend remains `b2201c24`. The previous-image guard deliberately rejects
redispatch against this new baseline. Establish current state before future work.

## Three-minute pagination completion (November 7)

The owner requires stopping any Actions run that exceeds three minutes and fixing
the cause. `deploy-job-summary-pagination.yml` now has a three-minute deadline.
Its default completion retains runtime `077b06ed` and updates only frontend to
already published `b2201c24`, with no rebuild/publication or runtime restart.
The exact currently observed baseline remains mandatory. The coordinator has a
90-second work deadline and 30-second rollout/drain bounds, plus owned rollback
and client/credential cleanup. Monitor queued time too; job timeout starts when
the runner starts. Do not leave a stalled run waiting beyond the owner's bound.

Prior successful package gates from `42367604849` and operations gates from
`42373358926` are verified against their exact commits. Application, dependency,
schema and runtime source changes invalidate reuse. Only the explicit completion
scripts, the PDF browser probe and documentation may differ from the operations
anchor; focused checks cover those changes. The original applied `ada21f57`
schema manifest and inventory baseline stay unchanged.

Frontend assets come from a never-started container of the exact immutable image.
The workspace browser test, public HTML/JS/CSS hashes and actual PDF worker probe
all use those same bytes. Authenticated complete job-summary traversal follows,
then session logout and owned SQL-client cleanup. Completion
[42375651095](https://github.com/salahassi/tenders/actions/runs/42375651095)
passed at `9e81488cb16f9a7fc148ae4089369f67732aea6e` in 115 seconds including
queue time. The authenticated production traversal returned all 1,795 jobs in
four pages (500, 500, 500, 295), with no full checkpoint fields or model requests.
Public image assets, PDF worker browser acceptance, configuration preservation,
session logout and both cleanup stages passed. See
[the final receipt](evidence/job-summary-release-passed-20261107-42375651095.json).
The observed frontend is now `b2201c24`; all four runtime targets remain
`077b06ed`. This one-time completion is finished: its previous-image guard
intentionally rejects another rollout against the new baseline. Read the entire
workflow and helper and establish current state before any future deployment.

`diagnose_promotion=true` selects the registry-read-only inspection job and skips
rollout. It verifies the published image and a local label-only promotion without
Kubernetes access or publication. Config-ID, manifest-ID and OCI-index formats
are bound through exact hashes/sizes and a unique matching platform; all native
config/layer/label guards remain enforced. Inspection `42370741371` passed.

## Current images and original release baseline

The November 8 model-settings receipt above is the current image authority: API
`f573e991`, three retained runtime targets `077b06ed`, frontend `522ad1b7`.
The schema ledger/catalog and original release baseline below remain unchanged.
Startup acceptance does not close the separate proposal issuance, provider or
export acceptance gates. The following November 5 release is historical.

[Run42031298536](https://github.com/salahassi/tenders/actions/runs/42031298536)
passes at main887411188b9591b01c9e3d01456372a37c3a0f68, with manifestada21f57.
The API and worker verified immutable runtime is
`registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:9a94ce1a89c66627157efb6b67536d94c1d6b6e414752d45af144d97bd74df07`.
See [the release receipt](evidence/proposal-release-passed-20261105-42031298536.json).
This is deployment evidence; current-request and export acceptance are separate.
The original release-baseline inventory below remains unchanged.

## Established route

**GitHub Actions on a GitHub-hosted runner → DigitalOcean management API →
short-lived kubeconfig → Kubernetes using the original cluster certificate
authority and hostname verification → the scoped repository operation.**

The cloud development container can reach DigitalOcean's management API, but its
outbound proxy rejects the Kubernetes upstream certificate with
`CERTIFICATE_VERIFY_FAILED` and HTTP 503. That direct-route limitation remained
in place when the runner route was established. Installing a certificate in the
container does not change the proxy's upstream trust. Reproducing the local 503
is not evidence that the working runner route or application has regressed.

Keep Transport Layer Security (TLS) verification enabled. Do not replace the
cluster certificate, disable hostname checks, unset the environment proxy or
change firewalls as a response to this known local limitation. Diagnose an actual
runner failure from that run's evidence if the established route fails.

## Fixed target and implementation

| Item | Repository target |
| --- | --- |
| Repository | `salahassi/tenders` |
| Cluster / namespace | `tenderdesk-dev` / `tenderdesk-dev` |
| Cluster ID | `a6093a76-a2d6-47fd-8697-579d41ed316f` |
| Region | `sfo3` |
| Kubernetes endpoint | `https://a6093a76-a2d6-47fd-8697-579d41ed316f.k8s.ondigitalocean.com` |
| Application origin | `https://tenderdesk.129.212.166.115.sslip.io` |
| Runner credential binding | GitHub Actions repository secret `DIGITALOCEAN_ACCESS_TOKEN` |
| Shared release preparation | [`digitalocean-runner.py`](../scripts/ops/digitalocean-runner.py) |
| Cluster/TLS validation | [`digitalocean-preflight.py`](../scripts/ops/digitalocean-preflight.py), `validate_cluster` |
| Current implementation and release evidence | [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md) |

The release preparation helper validates a checksum-pinned client and the exact
cluster, writes temporary credentials with private permissions, and preserves
original certificate/hostname checks. It also obtains image-registry credentials
for release work. Run it only inside its reviewed workflow, not as a local fix
for the proxy. Workflow cleanup must remove temporary credentials and private
plaintext even on failure. Never print token, kubeconfig, Secret or customer
payloads into this public repository or its public Actions logs.

## Select the operation before dispatch

Inspect the **whole workflow at the intended source revision**, including
conditional steps and the called helper. A name containing "check", "inspect" or
"diagnose" does not by itself establish that the run has no mutations.

| Need | Existing workflow and boundary |
| --- | --- |
| Diagnose persistent workspace loading | [`diagnose-workspace-startup.yml`](../../.github/workflows/diagnose-workspace-startup.yml) opens deployed settings in Chromium through an isolated genuine Owner session. It permits only same-origin GETs in the browser, reports counts/bytes/statuses without customer content, and removes the session and owned SQL client. It reads aggregate table counts, makes no deployment/business changes or model calls, and has a three-minute job bound. Inspect both `workspace-startup-diagnosis.py` and `.mjs` before use. |
| Inspect current workloads and schema | [`doks-access.yml`](../../.github/workflows/doks-access.yml), explicit `mode=inventory` on a revision containing `7b8808174fbf62d53364e56084102a901bc1338d`. It reads metadata through a temporary owned SQL client and verifies cleanup. `mode=bootstrap` still creates isolated compatibility resources and must be selected separately. |
| Exercise backup and restore before release | The same workflow with explicit `mode=restore` on a revision containing the reviewed cloud restore helper and a frozen release manifest. It reads production schema metadata, reconstructs that exact schema in a nonce-bound isolated database, applies the frozen migrations, and exercises genuine Auth/Storage with synthetic fixtures only. It does not copy customer rows or invoke models. Review [`proposal-cloud-restore.py`](../scripts/ops/proposal-cloud-restore.py), its fixture guards and cleanup before dispatch; a successful drill does not prove proposal rendering or production acceptance. |
| Qualify interrupted Storage retirement | [`qualify-storage-retirement.yml`](../../.github/workflows/qualify-storage-retirement.yml) uses the shared production mutex and original CA to create an isolated Auth/Storage/PVC fixture, deliberately interrupt after durable scale-to-zero, and resume from a fresh runner. It exercises the strict coordinator through a nonce-scoped adapter; its idle fixture worker does not prove production worker throughput or an actual inflight upload. Both jobs must remove private runner files and the final cleanup must verify owned-resource removal. Read the full workflow and [`cloud-retirement/runner.py`](../scripts/ops/cloud-retirement/runner.py) before dispatch; retain initial failures, bounded diagnostics and cleanup separately. |
| Read one proposal's recovery state | [`inspect-proposal-recovery.yml`](../../.github/workflows/inspect-proposal-recovery.yml). Requires the reviewed encrypted selection object and plaintext hash; does not authorize or retry model processing. |
| Start one explicitly authorized current proposal after verified release | [`request-current-proposal.yml`](../../.github/workflows/request-current-proposal.yml), following the [current-request runbook](CURRENT_PROPOSAL_REQUEST_RUNBOOK.md). Uses the deployed UI, genuine Owner session, fresh server details and durably recorded exact cancel-and-generate batch. The default verifies only; explicit activation may call paid providers. Existing prepared markers and unknown transport never auto-replay. |
| Check enabled model credential bindings | `doks-access.yml` with explicit `mode=models`. The reviewed [`model-configuration-audit.py`](../scripts/ops/model-configuration-audit.py) reads enabled catalog bindings and only reports provider/model and key/project presence booleans. It never prints aliases, credentials or project values, calls a provider, or changes configuration. Credential presence is not a provider availability or semantic qualification result. |
| Read retained proposal graph evidence | [`diagnose-proposal-graph.yml`](../../.github/workflows/diagnose-proposal-graph.yml). Follow its exact scoped input and private evidence handling. |
| Diagnose HTTPS startup | [`diagnose-https.yml`](../../.github/workflows/diagnose-https.yml). Contains conditional repair steps and private diagnostic upload; inspect trigger/conditions before using it. |
| Inspect image and release prerequisites without deployment | `deploy-proposal-delivery.yml` with explicit `inspect_qualified_image=true` pulls/verifies the qualified runtime and reads current worker/API resource and Storage-gateway/HTTPS prerequisite guards. It cannot publish, migrate, roll out or start customer work. Reports fixed stages/codes and removes private credentials. |
| Diagnose frozen schema without committing it | `deploy-proposal-delivery.yml` with both `inspect_qualified_image=true` and `diagnose_schema=true` runs the exact frozen SQL inside a rollback-only transaction. It may take temporary database locks, verifies the routine catalog remains unchanged, and cleans its owned SQL client. It emits only SQLSTATE/line, never raw SQL errors. This is distinct from read-only inventory and is not rollout. |
| Release application changes | Select the specific reviewed `deploy-*.yml` and its helper. Check the exact migration set, immutable image, target namespace, rollout and acceptance. Historical release workflows do not automatically include newly added migrations. |
| Evaluate models | [`evaluate-ai-models.yml`](../../.github/workflows/evaluate-ai-models.yml). Live activation is separate from inventory and may make paid provider requests; use only the authorized campaign and its limits. |

The release-baseline inventory was verified on the published branch
`codex/proposal-reliability-implementation`, commit
`17ba94ba3e6ee13c1227f60b8849c8fe40873564`, in
[run 41881660683](https://github.com/salahassi/tenders/actions/runs/41881660683).
Use a reviewed ref that contains that commit; older `main` revisions do not have
this input. For that published branch, the exact dispatch is:

```sh
gh workflow run doks-access.yml --repo salahassi/tenders \
  --ref codex/proposal-reliability-implementation -f mode=inventory
```

Check the run head SHA and executed steps after dispatch. The observed schema,
image digests and cleanup receipt are saved in
[`evidence/digitalocean-inventory-20261104-41881660683.json`](evidence/digitalocean-inventory-20261104-41881660683.json).
This evidence file wraps the inventory under `receipt`; release-manifest freezing
requires that exact inner receipt, not the outer evidence wrapper. The earlier successful run41849412810 remains historical evidence. Its predecessor
41845129587 failed an observer scheduling assumption; both subsequent successful
inventories verified the original certificate authority. That failure was not a
TLS regression.
Ten ready workloads prove inventory readiness at that observation, not proposal
workflow acceptance. The new delivery tables were absent at that time.

The isolated Auth/Storage restore drill subsequently passed all 13 actual HTTP
checks and both cleanup stages in
[run 41908346634](https://github.com/salahassi/tenders/actions/runs/41908346634),
at `fb43a7a3d54518b98cadbfc344d9c1ad4b6766f4`. Its
[receipt](evidence/cloud-restore-20261104-41908346634.json) records original CA
verification, exact file restore, access revocation and idempotent replay. This
run used a fixture Auth policy; it is not evidence for the later shared platform
policy, application rendering or production deployment. The later
[run 41910306855](https://github.com/salahassi/tenders/actions/runs/41910306855)
at `28689b97503b1fe23f0999909c91427867131c91` repeats all thirteen checks using
the shared platform helper and its frozen source contract. Its
[receipt](evidence/cloud-restore-20261104-41910306855.json) retains successful
original-CA verification and both cleanups. Production was not changed. The final 24-migration shared-policy drill also
passed all thirteen checks, original CA verification and both cleanup stages in
[run41933205779](https://github.com/salahassi/tenders/actions/runs/41933205779)
at `865d8406fcaf148299184bcbe67522fb0b256258`; its
[receipt](evidence/cloud-restore-20261104-41933205779.json) binds the complete frozen
release manifest. This is isolated restore evidence, not application deployment
or proposal acceptance. Use the checklist for the latest source-specific gates.

The subsequent read-only model binding audit succeeded at commit
`bc8e5709183fd228ae1bac207e643e2413e9c9fd` in
[run 41869042836](https://github.com/salahassi/tenders/actions/runs/41869042836).
Original cluster CA verification and both cleanup steps passed. The sanitized
[receipt](evidence/model-binding-audit-20261104-41869042836.json) records enabled
model key-presence booleans only; it does not establish provider availability or
credit balance. The earlier audit run 41863551387 passed TLS but failed because
the new diagnostic step omitted its existing database credential environment
binding. That workflow wiring was corrected; it was not a certificate failure.

When CLI run metadata is stale, inspect the connected GitHub run jobs and job
logs, checking the exact head revision and executed steps. A cached `queued`
response must not supersede a completed job's direct execution evidence.

Prefer the connected GitHub tools for metadata when available. With an already
configured GitHub CLI, these commands inspect definitions/history only:

```sh
gh workflow view doks-access.yml --repo salahassi/tenders --ref main --yaml
gh run list --repo salahassi/tenders --workflow doks-access.yml --limit 5 \
  --json databaseId,headSha,status,conclusion,url,createdAt
gh run view 41571450550 --repo salahassi/tenders \
  --json headSha,status,conclusion,url,jobs
```

Before execution, bind the operation to its reviewed commit, verify the selected
workflow inputs and existing authorization, then dispatch through GitHub Actions.
Do not start a deployment, bootstrap, recovery or model evaluation as a side
effect of an inventory request. Preserve private evidence transport and cleanup.

## Verification and historical proof

Known successful uses of the runner route:

- [October 25 access check, attempt 2](https://github.com/salahassi/tenders/actions/runs/40230328689/attempts/2): cluster readiness and original TLS verification passed.
- [November 3 runtime release](https://github.com/salahassi/tenders/actions/runs/41571450550): verified cluster access and the API/worker update steps passed.
- [November 3 graph diagnostic](https://github.com/salahassi/tenders/actions/runs/41572919737): scoped read-only diagnostic and credential cleanup passed.

For each new operation, record its run URL, exact head commit, relevant executed
steps, result, cleanup and remaining limits in the implementation checklist.
An overall successful workflow whose access/release steps were skipped is not
proof of cluster access or deployment. Historical success is not fresh workload
acceptance. A public HTTP 200 health response alone does not prove database,
worker, model, schema or complete user-flow health.

The original access explanation and migration history remain in
[`DIGITALOCEAN_KUBERNETES.md`](DIGITALOCEAN_KUBERNETES.md). Use this runbook as the
entry point and the dated checklist for current deployment facts.

## Additional capacity metadata in a new inventory

The additive `capacity_observation` field separates deployment resource requests
and limits from each ready API, worker and REST Pod's observed resource spec.
It reports fixed allowlisted runtime role and REST pool/max-row/anonymous-role
configuration only. The authenticator role is projected only after validating
the current core Secret's existing private-database and original-CA URI binding
and the observed manifest reference; the URI, host and credential values are
never output. These are manifest/current-configuration observations, not a read
of the running process environment or cgroup usage. Missing explicit values stay
unknown; repository-rendered defaults do not fill them in.

The managed database size slug and node count come from the existing validated
DigitalOcean metadata request. That endpoint's size name does not establish
measured per-node RAM or CPU. Those fields remain null without an authoritative
unit-qualified hardware record; no size-name inference qualifies a benchmark.

`sql_settings` captures the fresh observer login's `statement_timeout`, `work_mem`
and `max_connections`, including units/source/reset/default values, before its
own 20-second query timeout. It separately lists only these three parameters'
current-database and fixed application-role catalog defaults. The query rolls
back and reads no business records. Neither `SET ROLE` nor an administrator
connection proves the effective settings of an authenticated PostgREST request;
the receipt explicitly leaves that claim false. The original inventory/schema
fields and frozen release baseline remain unchanged, and older receipts are
still valid for their original scope. A reviewed new Actions inventory is needed
to obtain these observations; adding this code does not supply hosted evidence.

The additive capacity inventory subsequently passed in
[run 41916625820](https://github.com/salahassi/tenders/actions/runs/41916625820)
at `84003906146c9b2970641348cfe67d84bb17e210`, including original-CA verification
and both cleanup stages. Its
[receipt](evidence/digitalocean-capacity-20261104-41916625820.json) records actual
API/worker/REST manifest limits and safe database configuration metadata. It
does not replace the earlier frozen release baseline or qualify runtime memory,
provider availability, or an application release.

## Legacy batch replay exposure census

A subsequent inventory may include the additive `legacy_batch_observation`.
Its fixed scope is `app_private.idempotency_records` with `method='BATCH'` and
`route='commands'`. It reports global counts of unexpired (`expires_at > now()`)
and expired rows, grouped only by the fixed compression labels `none`, `pglz`,
`lz4` or `other`. Each group includes SQL-null result counts, the sum/maximum of
`pg_column_size(result)`, and cumulative stored-size counts at 64 KiB and 1 MiB,
plus a count above 1 MiB. These thresholds organize metadata; they are not new
business quotas or evidence that a result can be safely expanded.

The query uses `pg_column_compression`, `pg_column_size` and SQL-null detection;
it never serializes, hashes, parses, expands or emits result JSON. No workspace,
actor, row, idempotency key or payload is returned. Only the at-most-eight metadata
groups are materialized. The original read-only transaction, application-owner
role and 20-second statement/5-second lock bounds remain in force. Failure still
requires verified temporary-client cleanup and does not produce a success receipt.

Compressed stored size is not uncompressed JSON, response size or replay memory
capacity. Purged sentinel objects cannot be counted safely by this census without
inspecting their contents, so `purged_state_not_inspected` stays true and
`logical_or_wire_size_proved` stays false. SQL-null results are counted separately
and are not relabeled as purged. The census describes the namespace at observation
time; it does not alter, normalize, expire or replay any record. Older inventory
receipts and the frozen release baseline remain unchanged. A reviewed fresh
Actions inventory supplies actual exposure; synthetic tests do not establish it.

The first actual legacy census passed in
[run 41919585078](https://github.com/salahassi/tenders/actions/runs/41919585078),
at `e0ce84d2cb770fd09d5192a398833b88f0c2628b`, with original-CA verification and
both cleanup stages. Its
[receipt](evidence/digitalocean-legacy-batch-20261104-41919585078.json) reports
zero total/active/expired BATCH/commands receipts at observation. A release must
still fence/drain legacy callers and recheck under locks; this read-only result
does not establish future absence or replace the frozen release baseline.

## Read-only command cutover visibility observation

Inventory also reuses `command-batch-cutover.py`'s exact read-only transaction
observer. It verifies the fixed database and existing authority to set the
authenticator role, sets that role locally, and counts only that login's
transactions, excluding its own observer backend. It does not need or add
global monitoring privileges. The public `batch_cutover_observation` contains
only a UTC database marker, visibility flag, count, fixed authority description
and SHA-256 of the exact observer SQL. Private session identifiers, query text,
credentials and customer content are never returned. The transaction rolls back.

An observation does not fence requests or drain transactions; both flags remain
false. It does not prove future emptiness. Release still observes a fresh marker
after the gateway process fence and performs its separate bounded drain, table
lock and zero-history check. Unknown visibility fails the inventory and still
requires temporary-client cleanup. Review the complete workflow before running
`mode=inventory`; this addition never invokes the mutation coordinator.

The combined read-only visibility/resource observation passed in
[run 41926843276](https://github.com/salahassi/tenders/actions/runs/41926843276)
at `da3c4bcde412f17287f7abd3c5c28779abda26d3`, with original-CA verification
and both cleanup stages. Its
[receipt](evidence/digitalocean-cutover-20261104-41926843276.json) proves existing
managed-database transaction visibility and actual gateway spec values at that
observation. It neither fences callers nor drains transactions, changes grants,
measures runtime capacity or replaces the original release baseline.

The subsequent [run 41928176279](https://github.com/salahassi/tenders/actions/runs/41928176279)
at `f331c28f727f19623715be00f98a001bd04185bb` adds actual HTTPS Deployment/Pod
resource observations (128 MiB / 300m), with original-CA and both cleanups. Its
[receipt](evidence/digitalocean-https-capacity-20261104-41928176279.json) remains
read-only configuration evidence; it does not qualify proxy capacity or replace
the original frozen release baseline.

## Isolated interrupted storage retirement

`qualify-storage-retirement.yml` uses this same original-CA GitHub runner path and
shared production concurrency group. It provisions a separate nonce-owned
namespace, database and PVC; it does not invoke the fixed production retirement
adapter. Its first job deliberately exits after durable process capture and
scale-to-zero, and its second job resumes from a new runner. Read the full
[qualification runbook](STORAGE_RETIREMENT_QUALIFICATION_RUNBOOK.md) and workflow
before dispatch. Source preparation and local tests are not evidence of a
hosted pass. Preserve strict original-process proof and owned cleanup on failure.
