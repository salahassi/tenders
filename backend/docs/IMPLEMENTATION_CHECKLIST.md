# Implementation status and continuation plan

## November 8 — bounded SQL-only retry compatibility release

The new release workflow applies only the reviewed modern-routing retry migration;
all five deployed images, workload definitions, private configuration and provider
settings remain unchanged. The atomic schema wrapper starts from the exact
deployed dispatch SQL/catalog/structure receipt, preserves every existing row and
schema/authority attribute except the reviewed command body, and permits only
the new private invoker helper. It appends a separate checksum/catalog/structure
receipt after these checks, retaining the original application and dispatch
release rows byte for byte. A lost COMMIT acknowledgement triggers one read-only
verification, never an apply retry or speculative DDL rollback.

Trial verification now explicitly accepts either the exact predecessor state or
the complete new receipt with its exact current catalog. Partial receipts,
untracked changes, wrong source hashes or unknown later schema changes fail
closed. There is no exception-based fallback to weaker validation. Runtime image
qualification remains valid because the change affects migrations and operations
only, outside the immutable image's copied inputs.

Local operations validation: 12 tests pass, including an executable PostgreSQL
transaction with eleven mutation/authority fault injections, unchanged predecessor
receipts, replay, read-only observation, partial-ledger rejection, bounded SQL
transport and unknown-commit reconciliation. Workflow YAML, shell and embedded
Python syntax pass. The run deadline includes queue/setup and reserves owned
client cleanup inside 170 seconds. No production deployment or business retry
has been performed by this release change; hosted acceptance remains pending.
Independent review reproduced an initially omitted target-function attribute
check; full `pg_proc` equality except the body now rejects immutable/strict or
other unreviewed command-attribute changes. Both regressions pass with the fix.

## November 8 — modern model routing in saved proposal resume

The canonical whole-plan retry guard still recognized only the legacy
`model_routing.enabled` setting. Modern task-model routes use a separate
execution setting and retain their own automatic route checkpoints, so unrelated
historical unknown usage could prevent an otherwise eligible current proposal
from resuming. The new migration changes only that admission predicate beneath
the existing Owner, revision, evidence, source, current-contract and idempotency
checks. It recognizes the actual modern admission cutoff and existing catalog
continuations without converting old manual checkpoints or paid work. Local
stage transitions are distinguished from model calls; local-only work retains
the admission requirement for future model steps.

Reserved usage still blocks whole-plan retry. A current ambiguous call on a
resumed model job still blocks; eligible old ambiguity retains every receipt and
model allowance and gets the existing recovery audit. Provider reservation
continues to enforce account, model, input and phase identity. No usage row,
provider setting, frozen input or previous issuance is rewritten. The added
helper is private, SECURITY INVOKER, and inaccessible to browser/service roles.

Implementation and independent review are complete in an isolated worktree.
The 12 latest-schema retry regressions and 15 issuance tests pass, including
new issuance admission, unchanged 600-second clock on replay, preserved unknown
and reserved accounting, nonempty model budgets, manual policy, cutoff changes,
local transitions, frozen routes and private helper privileges. Backend
typecheck/build pass. Full backend/frontend tests and frontend build are in
progress. Deployment and hosted retry acceptance remain pending; this change
has made no live command, provider, deployment or customer-data mutation.

## November 8 — authorized technical and financial proposal trial

The Owner explicitly selected an actual technical/financial proposal generation
trial after the dispatch correction. The new `proposal-trial.yml` coordinator
uses the current deployed image/schema baseline and the canonical authenticated
command API. It resumes eligible saved work, observes existing active/issued work,
or starts fresh only when the saved contract/evidence cannot be reused and no
active proposal version exists. It never automatically resubmits an uncertain
command. An encrypted, read-back-verified stable intent precedes its single send;
fresh expected revisions, genuine Owner membership and server admission remain
authoritative. No provider settings, deployment or customer evidence is changed.

Observation and download are separate read-only invocations against the exact
issuance, including its actual command operation and original 600-second clock.
Each Actions invocation includes queue/setup in a 170-second bound with reserved
session logout, owned database-client cleanup and encrypted report transport.
Only opaque references and content-free progress reach logs. Issued files are
downloaded through canonical authenticated GETs, checked against unchanged package
metadata, hashes, sizes and strict DOCX structure. Visual layout is a separate
acceptance step. This is an operations harness, not an application redeployment.

Local verification: 16 request, 10 observer and 12 download controls pass, including
full-migration read-only SQL fixtures, exact issuance isolation, unknown-send
handling, artifact integrity and a reviewed UTF-16 entity regression. Eleven
coordinator checks and all 15 private-transfer checks pass. The optional transfer
HTTP cap preserves existing defaults while limiting this runner's key-revocation
cleanup to ten seconds. Independent integration review closed active-state
polling, ambiguous-send reconciliation and cleanup-reserve findings. Both package
typechecks/builds and the frontend's 389 tests retain the preceding release's
evidence because application/dependency/schema inputs are unchanged. The prior
backend full-suite result remains 3,513/3,514 with the unchanged affected file
passing 18/18 in isolation; it is not represented as a new green complete run.
Hosted generation, actual file download and final duration remain pending.

The first harness run [42506306648](https://github.com/salahassi/tenders/actions/runs/42506306648)
at `e4c4e81` stopped after 37 seconds including queue, before any generation send:
the privately recovered encrypted report confirms `send_attempted=false`,
`request_sent=false`, `intent_persisted=false`, and owned-client cleanup success.
Private input transfer failed with `DO_API_NETWORK_OR_TLS_FAILURE`; report bytes
were persisted despite the same error during transfer completion. The initial
five-second HTTP cap was too short for this observed path. It is now ten seconds,
with a corresponding 70-second final reserve; the three-minute run bound is
retained. This is a harness/access failure, not a proposal-model outcome.
An independent scoped transfer probe measured key creation at 4.146 seconds and
revocation at 5.361 seconds; final inventory contained no keys. This explains the
five-second cap failure without attributing it to application processing.

The corrected run [42506565368](https://github.com/salahassi/tenders/actions/runs/42506565368)
at `ca2ce7f` completed private transfer and cleanup in 48 seconds including queue.
It sent no generation command and persisted no request intent: admission inspection
stopped at `PROPOSAL_TRIAL_PRECONDITION_USAGE_READY`. A read-only inspection mode
now retains the request proof and bounded usage/job metadata to distinguish an
active reservation from unknown historical usage before choosing the canonical
operation. It neither settles usage nor changes routing or provider configuration.

Read-only inspection [42506879559](https://github.com/salahassi/tenders/actions/runs/42506879559)
at `5382232` passed in 51 seconds including queue. It found no reserved provider
usage, historical unknown usage, enabled modern execution/configurations, disabled
legacy routing, and a failed current-contract plan with unchanged evidence and
no active proposal version. Canonical retry still consults the legacy routing
guard; canonical fresh generation does not. The harness now chooses the normal
fresh `proposal.generate` command when this retry-only guard prevents reuse,
while retaining failed/canceled-plan, active-version, lease and concurrent-plan
checks. It sends no retry followed by generation. All 18 request controls and
12 coordinator controls pass; saved work and unknown accounting are retained.
The application retry compatibility defect is being corrected separately.

The single authorized `proposal.generate` was accepted in
[42507148785](https://github.com/salahassi/tenders/actions/runs/42507148785)
at `b7b9a60` (62-second run). Its database clock is 17:53:30–18:03:30 UTC.
Authenticated command, exact durable intent, issuance binding and cleanup pass.
Read-only observations `42507262148` (103 seconds) and `42507449383` (99 seconds)
retain that exact request and deadline. At approximately 257 seconds, two of
twelve analysis jobs had completed; two were waiting and eight queued. A separate
successful render job is not counted as complete analysis or an issued package.
Full proposal completion is still unproven. The observer now adds a bounded,
content-free private attempt timeline to distinguish model skips, accepted calls,
poll exchanges and provider latency without changing processing or its deadline.

## November 8 — remove synchronous proposal dispatch waits

**Deployed:** [42499311138](https://github.com/salahassi/tenders/actions/runs/42499311138)
at `40c0cd15` passed in **69 seconds including queue time**. Worker and scheduler
now run immutable `c6f7cce5` (artifact source `e2e209d`, native image `4b04acaa`).
Both report ready; the unauthenticated maintenance probe returns 401. The exact
registry manifest/configuration binding, additive SQL transaction and subsequent
read-only schema verification pass. New runtime SQL checksum `0888f615`, routine
catalog `abe81b43` and structure `1857408e` are recorded in their own release
ledger; the original `ada21f57` baseline ledger remains. Existing business rows,
private configuration and API/frontend/source-browser images are preserved.
Owned observer removal and private runner cleanup pass. The
[release receipt](evidence/proposal-dispatch-release-passed-20261108-42499311138.json)
retains the exact evidence. Full customer proposal completion remains unverified;
this release did not start a new request, retry customer work or enable providers.

The first rollout [42498570824](https://github.com/salahassi/tenders/actions/runs/42498570824)
at merged source `a22fc8f` stopped in preflight after 52 seconds including queue
time. It reached no schema or image mutation; both cleanup stages passed. The
release step consumed 40.25 seconds against its initial full-image pull's
40-second subprocess bound. The failure receipt preserves the generic error
and identifies this as the probable cause, not a confirmed network diagnosis.
The corrected runner will verify immutable registry manifest/configuration
metadata against the already pull-verified publication, avoiding another full
image download before the actual cluster rollout. The successful run above
closes this deployment failure.
The corrected helper's actual registry check passes in 0.817 seconds, binding the
exact 5,123-byte manifest to native-qualified config `4b04acaa` and 23 layers.
All 26 focused release/schema controls pass, including digest corruption,
wrong configuration, ambiguous platforms, external URLs and timeout rejection.
Independent review confirms that the original full publication/source proof is
retained; the hosted preflight now downloads metadata only.

Implementation separates persistent worker foreground processing from awaited
housekeeping. The foreground returns a validated future-poll hint without
sleeping; the scheduler records that hint in a durable outbox, immediately
continues after claimed work, and retains the scheduled wake through empty
follow-ups or process restart. Maintenance has an independent authenticated
endpoint, durable lease and cadence. Existing business admission, job leases,
provider request identities, issuance deadline and Edge invocation behavior
remain authoritative.

Focused worker controls pass 64 tests and scheduler controls pass 24 tests.
The actual dispatcher SQL passes isolated PostgreSQL tests for due-wake races,
expired leases, multiple independent future timers, maintenance and role restrictions.
Both groups pass backend typecheck. Candidate runtime `4b04acaa`, built from
`e2e209d` using an offline dependency cache, passes all nine native controls
with the actual default worker and actual scheduler entrypoints. With maintenance
held, a ready response takes 9 ms and returns the 30,000 ms poll hint; idle
responses take 7 ms and 2 ms. These are isolated synthetic RPC fixtures, not
customer model latency. The original image fails the idle-maintenance negative
control. Exact copied sources, image configuration/layers and container cleanup
are bound in the build/native/qualification receipts. Published immutable runtime
`c6f7cce5` was pulled and reverified with temporary registry credentials removed.
All 389 frontend tests, both package typechecks and both builds pass. The frozen
backend suite passes 3,513/3,514 tests; one existing delivery integration exceeds
its unchanged five-second timeout under the complete suite. Its unchanged file
passes all 18 tests in isolation. This retains the full-suite limitation rather
than claiming a green full backend run. All new worker regressions pass in the
complete run. Production readiness passes in the run above. Schema application must precede
worker readiness and scheduler replacement; rollback restores scheduler first.
The schema change is additive and legacy dispatch acknowledgement is retained.
All 21 focused release/schema controls pass. Independent review closed findings
on partially restored pods, paused-scheduler detection, elapsed queue/setup
budget and owned observer cleanup. The workflow binds its deadline to GitHub run
creation and reserves rollback/cleanup inside 170 seconds, below the three-minute
owner limit. It does not activate a paused scheduler or initiate a generation.

This correction addresses the reproduced synchronous wait and maintenance
coupling. It does not establish a new full-proposal completion time. No new
customer generation or paid-provider evaluation is started for these tests.
The accepted-model poll policy remains 30 seconds. With twelve analysis chunks,
two accepted-request slots and at least writer/verification phases, an idealized
all-pending case already needs approximately 360 seconds of poll-slot time for
analysis before later proposal stages or repairs. This conditional estimate is
not a measured production duration; full issuance acceptance remains separate.

## November 8 — read-only diagnosis of the ten-minute proposal failure

The follow-up diagnostic adds a timing history bound to the exact selected plan,
so a later user request cannot redirect the investigation. Attempts, usage and
queue-wake arrays each have a 2,048-row serialization limit, exact totals and
explicit truncation flags. Five inspection controls pass against the complete
synthetic migration set, including exact-plan isolation, chronological ordering,
private-field exclusion, cap behavior and unchanged records. This is a read-only
diagnostic change; application runtime and schema are unchanged.

Static tracing identifies synchronous dispatch coupling: the persistent scheduler
awaits the worker response; that response awaits a future accepted-model poll wake
and then maintenance. A controlled composition of the actual scheduler and wake
helper reproduces a 30,000 ms dispatch hold with zero model/network delay. This
reproduction establishes the blocking path, not its exact historical duration.
The composed parallel-request migration permits other jobs' known reservations
during a poll wake; the original pre-migration single-reservation guard must not
be mistaken for the currently deployed logic.

[Exact-plan follow-up42495403060](https://github.com/salahassi/tenders/actions/runs/42495403060)
at `0deb12149089b20698d2965531ea7992a4cebf8f` passed in **88 seconds including
queue time**, with all five inspection controls and both cleanups. Its privately
downloaded report matches the original failed plan and has no timing truncation.
It contains 28 attempts: 15 unconfigured-model skips taking 0.193 seconds total,
seven generation HTTP exchanges taking 12.177 seconds, and six poll exchanges
taking 2.424 seconds. These exchange durations exclude asynchronous provider
processing, so the remaining request duration is not an idle-time measurement.

Four successful result-to-next-sent-phase gaps measure approximately 52–55 seconds.
Graph yield makes the job due immediately. A committed wake precedes the next
selected generation by 46.958 seconds; the last accepted repair precedes its
poll wake by 30.100 seconds. Combined with the actual scheduler/wake reproduction,
these observations establish internal scheduling delay. They do not divide each
gap among maintenance, other workspace work, claim and input preparation. The
exact-plan attempt projection deliberately excludes other workspace attempts.

Both packages pass typecheck and build. Full package suites run concurrently
report backend 3,498/3,499 and frontend 388/389: one existing five-second backend
test timeout and one frontend button lookup failure. The exact affected files
pass unchanged in isolation (18/18 and 19/19). These are separately retained
results, not a claim of a fully green combined run. No application fix or
deployment is included in this diagnostic branch.

[Inspection42468242137](https://github.com/salahassi/tenders/actions/runs/42468242137)
at `6abffe096398af83bc5e4cdb468736427151733c` passed in **85 seconds including
queue time**. All five read-only inspection controls, original cluster certificate
authority access, temporary observer removal and private runner cleanup passed.
The encrypted report was downloaded privately and its plaintext SHA-256 verified.
The sanitized [receipt](evidence/proposal-timeout-diagnosis-20261108.json) retains
the observation, source and evidence limits without customer identifiers or text.

The selected opportunity's newest request was accepted at 08:45:28.039854 UTC
and durably failed at its original 08:55:28.039854 deadline. Of twelve analysis
jobs, one succeeded, two began but did not complete, and nine had zero attempts.
The first chunk committed after approximately 275 seconds. Seven accepted model
requests have settled usage totaling 517,372 input and 21,259 output tokens.
The last retained operations include grounding verification and result repair;
repair was admitted with approximately ten seconds remaining. There are zero
proposal versions. This is actual processing throughput failing the issuance
deadline, separate from the earlier November 5 no-agent failure.

The current execution setting permits two parallel requests; the read does not
establish its value during the failed request. Large input counts warrant prompt
and verification profiling, but do not prove that complete source documents were
repeated for each chunk. The retained projection cannot separate provider latency,
polling delay and processing time for every call. Scheduler metadata is fresh at
observation; it does not by itself reconstruct historical dispatch timing.

No model request, business retry, configuration change or deployment was made by
this diagnosis. Proposal issuance/export acceptance remains failed. Further
implementation should measure and improve per-chunk analysis, verification,
repair and scheduling within the existing deadline, then obtain separately
authorized actual-request evidence. The old graph inspector expects identical
API and worker images and must not be dispatched unchanged against the current
intentionally mixed image baseline.

## November 8 — model settings saves and repeated workspace reads

**Deployed and accepted:** [run42465497658](https://github.com/salahassi/tenders/actions/runs/42465497658)
at `c804cffa87c5d95ef3be837b9911863496ec3edf` passed in **113 seconds including
queue time**. Only frontend changed to `522ad1b7`. Genuine production settings
startup completed in **8,898 ms / 37 API reads**, then two clock-advanced polls
each made exactly **one status read, zero catalog reads and zero business reads**.
All requests returned 200, all 16 table counts matched (including 1,808 jobs),
and the page settled without alerts, browser errors or a loading skeleton.
The same immutable image passes four isolated enable/disable saves at six
requests each, changed-catalog polling and sidebar navigation. Production
provider settings were not toggled to obtain this evidence. Public HTML and
all 55 code assets match the image, and the actual PDF worker probe passes.
Schema/configuration preservation, session logout and both cleanup stages pass.
The [final receipt](evidence/model-settings-release-passed-20261108-42465497658.json)
separates isolated save evidence from genuine read-only production acceptance.
Initial workspace startup still reads all business collections once; this closes
save/poll amplification, not that broader loading cost or independent proposal
and provider availability acceptance. The prior diagnosis follows.

**Reopened:** the November 7 acceptance measured startup only. It did not
exercise a model/connection save or the following minute's status poll. Every
`runCommand` still refreshed the whole repository before the model component
read its own five resources; the polling effect also began without a loaded
change-token baseline. Different cursor values are continuation pages, but
loading all business history after each catalog edit is unnecessary.

The four catalog commands now retain server revision/idempotency validation and
refresh their own catalog only. A status token is captured before loading rows,
so changes concurrent with the load remain detectable. On the models page,
changed status refreshes catalog data and defers business history until actual
router navigation; the destination waits for authoritative rows. Unchanged
polls request status only. Business commands keep their existing full refresh.
Late catalog reads cannot replace newer results, unsaved forms retain their
revision, and read failures have an explicit reload action.

Verification: all 389 frontend tests, typecheck and build pass. Integrated
provider/component regression covers
connection/model disable and enable, request counts, unchanged/changed polls,
sidebar navigation, failed writes, business saves and changes during loading.
The isolated Chromium fixture passes against the built UI: four connection/model
disable/enable saves each use six requests; first/unchanged polls use one; a
changed poll uses six catalog/status requests; sidebar navigation reloads once.
The same fixture against baseline `bd59f7a` reproduces the first-poll waterfall
(status + bootstrap + all 16 lists). The existing 1,201-job/10,501-audit browser
fixture also passes. There are no external/provider requests or production
configuration changes. Twenty-three focused operations controls pass. The first full
backend run passed 3,498/3,499 tests; an unchanged delivery pipeline test exceeded
its existing 5-second limit. The subsequent complete backend run passes all
3,499 tests without changing that limit, and both package typechecks/builds pass.
Immutable frontend `522ad1b7` is built from `f5e4e5a`, published and pull-verified
with identical image configuration/layers and temporary credential cleanup.
Hosted acceptance passes in the run recorded above.

Deployment **passed**. The three-minute `deploy-model-settings.yml`
updated only frontend against the observed `b2201c24` baseline. It retains API
`f573e991`, the other runtime images `077b06ed`, private configuration and the
original applied schema. It checks exact image assets and isolated toggles,
then genuine read-only production settings startup and two clock-advanced
polls, plus public asset/PDF acceptance, guarded rollback and cleanup. Production
provider enablement and credentials are not modified. Initial full-workspace
startup remains a separate cost; this change scopes saves and later polling.


## November 7 — excessive workspace job pagination

**Full settings startup is now deployed and accepted:**
[run42384215963](https://github.com/salahassi/tenders/actions/runs/42384215963)
at `51bf7b134d811b6c9a68006db8b0e48b5fa8f951` passed in **123 seconds including
queue time**. The genuine authenticated production browser opened settings and
rendered Models & providers in **10,335 ms**, completed **36 API requests**, and
reached network idle with no skeleton, alerts, browser errors or blocked requests.
All 16 startup table counts matched: 119 opportunities in three requests,
106 fit assessments in four, 32 source runs in one, and 1,795 jobs in four.
Every observed API response was HTTP 200. This is an observed run, not a universal
latency guarantee. No model calls or business writes occurred.

Only API changed to `f573e991`; worker/source-browser/scheduler remain `077b06ed`
and frontend remains `b2201c24`. The applied `ada21f57` ledger, `8f82c881` catalog
and workload/private configuration are preserved. Session logout, owned SQL-client
removal and both workflow cleanup stages passed. Duplicate provider-sync run
`42384177656` was cancelled during verification; its discover/bind/reload/recover
jobs executed no steps. The [final receipt](evidence/workspace-pagination-release-passed-20261107-42384215963.json)
closes the reported startup request amplification. Independent proposal issuance,
provider availability, retrieval and export gates remain separate. The following
diagnosis and earlier attempts are retained as historical evidence.

**Reopened after the owner's report:** the prior four-page production check
proved the job-summary endpoint, not complete authenticated settings startup.
The public frontend currently serves index SHA `aaa576da`, matching the deployed
image, with `Cache-Control: no-store`. Startup still sequentially reads other
full-content tables. A bounded real-browser diagnosis now records per-resource
request/page counts and aggregate table sizes, with only same-origin GETs,
no customer content in logs, a genuine isolated Owner session, logout and owned
client cleanup. It does not change deployments or call models. The workflow
retains the three-minute deadline. Cause and end-to-end acceptance remain open.
Diagnostic `42381366914` failed before a browser result in 24 seconds; both
cleanup stages passed. Bounded stage/type/source-line diagnostics are added to
identify the setup failure without exposing exception payloads or credentials.
Run `42381483301` isolates a missing `DIGITALOCEAN_ACCESS_TOKEN` binding in the
observer step before temporary client creation. The workflow now supplies that
existing secret to the observer; the browser child still strips it. A focused
workflow binding regression check is added. Both failed runs cleaned up.
Diagnostic `42381585874` completes in 139 seconds and confirms the remaining
amplification: 119 opportunities require 120 requests, 32 source runs require 33,
and fit assessments are still one per request (106 total in the database).
Job summaries remain four requests for 1,795 jobs. The probe stops at its explicit
200-request cap; its resulting alert is diagnostic-induced, not a production
server error. The [aggregate evidence](evidence/workspace-startup-before-20261107.json)
contains no customer content. Both cleanup stages and isolated session logout pass.

The correction batches small complete rows into byte/time-bounded HTTP pages
while retaining one-row database reads and the heavy-read admission lane. A page
holds at most a conservative 1 MiB bound of small rows; an oversized row is sent
alone, without fetching a second large row. The two-second soft work bound and
cursor continuation preserve complete history without arbitrary record loss.
All business fields remain intact, including null/zero/false and full text.
Raw job reads retain their original one-record policy; job summaries are unchanged.
New tests cover escaping/Arabic/emoji, oversized boundaries, exact continuation,
work duration and all three affected tables. The immutable-image PostgreSQL/API
fixture now also verifies 119 full opportunity records and preserved descriptions.
Deployment and complete real-page acceptance remain pending.
Local checks pass: 3,499 backend tests / 206 files, 383 frontend tests / 60 files,
both package typechecks/builds, and 72 focused list/admission controls. Runtime
`9566a11c` is built from `346f0b9`. The first native artifact save hit local ENOSPC;
unused build cache cleanup restored space without deleting images or evidence.
Three subsequent native DOCX scopes pass at 384 MiB / 700m. The new API fixture's
loopback adapter initially rejected its newly added `opportunities` read; it now
permits that exact GET route. Application/runtime COPY inputs remain unchanged;
the failed fixture receipt and cleanup are retained before the focused retry.
The corrected native API fixture passes at `7b464c2`: 119 complete opportunity
records in four requests, with 118 exact seeded descriptions verified, alongside
1,201 large-checkpoint job summaries in three requests and the complete 100-result
412,758,765-byte stream. API peak memory is 167,448,576 bytes under the unchanged
402,653,184-byte / 700m limit, with no OOM and verified cleanup. All four native
scopes qualify the exact `9566a11c` image; build revision `346f0b9` and the later
fixture-only correction are separately bound. No product code override is used.
The qualified runtime is published and pull-verified as `runtime@sha256:f573e991e622c982e82a4a3b4e6dc6f144e87586ba0f5dd0b3d05381b30dbd6a`.

The new three-minute `deploy-workspace-pagination.yml` changes only the API image.
It requires the observed `077b06ed` API/runtime and `b2201c24` frontend baseline,
strict qualification/configuration/schema guards, owned rollback, and actual
authenticated settings readiness with every startup table count matched. A
successful diagnostic collection alone cannot satisfy acceptance: models must
render, network requests must settle, the skeleton/errors must disappear and
the read count must remain below 100. Its 105-second coordinator bound reserves
time for cleanup/rollback. The new source manifest changes runtime qualification
metadata only; the original deployed `ada21f57` ledger/catalog are preserved.
The qualification tests now pin the newly verified image/source explicitly;
34 Python release/qualification/manifest regression controls and three
browser-boundary tests pass.
Production update and complete UI acceptance are still pending.

**Deployed and accepted:**
[run42375651095](https://github.com/salahassi/tenders/actions/runs/42375651095)
at `9e81488cb16f9a7fc148ae4089369f67732aea6e` passed in **115 seconds** from
creation to completion, within the owner's three-minute limit. The image-bound
workspace browser, public HTML and all 55 code asset comparisons, and actual PDF
worker browser probe pass. A genuine temporary Owner session traversed all
**1,795 production jobs in four requests (500, 500, 500, 295)**, matching the
database count, terminating on the last cursor and returning no checkpoints or
lease credentials. Model requests and business mutations were zero. The session
was logged out and both owned-client and private-runner cleanup stages passed.

Only frontend changed to `b2201c24`; the four runtime targets remain `077b06ed`.
The `ada21f57` schema ledger, `8f82c881` catalog and workload/private configuration
are preserved. The run passed 29 current focused operations controls and verified
the exact source-bound reuse of the previous complete package and 715-operations
gates. See [the final receipt](evidence/job-summary-release-passed-20261107-42375651095.json).
This closes the reported startup job-request amplification defect. Independent
proposal issuance/provider/export work remains governed by its existing open
gates. The following attempt history is retained as historical evidence.

The reported settings-page waterfall is reproduced by the production contract:
the repository asks for 500 jobs, while the full-content API deliberately limits
heavy `jobs` pages to one row. Startup drains the entire history serially before
opening any page. These are authenticated application reads, not model requests.

The correction adds an authenticated `job-summaries` list with selected scalar
status/revision/attempt fields and two scalar routing counters. It fetches up to
500 summaries with one metadata lookahead row and never selects complete
checkpoints or lease credentials. The original full job list/detail routes keep
their single-record heavy-content protection. Workspace startup consumes every
summary page without a record-count ceiling. Source/routing checkpoint details
load only when the user opens a task, with abort and explicit retry; no automatic
retry loop is introduced. Model processing and usage accounting are unchanged.

Local checks pass: 74 focused API/projection tests; all 383 frontend and 3,493
backend tests; both package typechecks/builds. Chromium renders all 1,201 jobs
with three summary requests and no full job reads on startup; existing 10,501-row
audit paging and failure isolation remain verified. The actual immutable-image
PostgreSQL/PostgREST/API fixture also returns 1,201 roughly 61 KiB checkpoints as
three metadata pages, with no checkpoint fields. All four native scopes pass at
the unchanged 384 MiB / 700m application limits, including the 100-result stream
and DOCX delivery cases. Image `aeb8e3c3` is published and pull-verified as
`runtime@sha256:d34fb3616c639938b8fc81a5dd1c2a5f31fb002c55fab446adb259a47833baa4`.
This publication alone is not a deployed application.

The first new fixture exceeded the real 64 KiB checkpoint constraint; the second
used an unapproved synthetic CORS origin. Both failed receipts and verified
cleanup are retained. The final fixture uses about 61 KiB and the existing
allowed origin. Neither database constraints nor CORS policy were relaxed.
Build revision is `b699275`; the final API fixture is `927d896`, with exact runtime
COPY/build inputs unchanged. Receipt limits distinguish these revisions.

The reviewed image-only deployment workflow verifies the already applied
`ada21f57` schema ledger and `8f82c881` catalog before and after rollout. It checks
the exact currently deployed images, preserves all workload configuration,
uses guarded image patches and rollback, checks public frontend assets, and
reads complete job summaries through a genuine temporary Owner session. It
logs out and removes its owned SQL client. It never runs migrations or retries
processing. The new source manifest changes runtime qualification metadata only;
the original applied manifest and original inventory baseline remain retained.
Hosted run `42367604849` at `84b33ca` passes all 383 frontend / 3,493 backend,
705 operations, 11 schema and 16 Kubernetes checks, both package typechecks/builds,
and the 1,201-job Chromium fixture. Original-CA access succeeds. Image preparation
then refuses `DELIVERY_IMAGE_RAW_IDENTITY_MISMATCH`, before any workload update;
cleanup succeeds. Hosted deployment remains pending. A fixed-field raw-image
metadata diagnostic is added to identify the engine presentation mismatch while
keeping image bytes/platform/filesystem validation enforced. Read-only inspection
`42369591871` confirms platform/rootfs differences; an additional hash-only
diagnostic distinguishes an OCI manifest ID from its referenced configuration ID.
Inspection `42369696495` proves Docker reports manifest `d34fb361` as its ID,
whose SHA-bound config descriptor is exactly qualified config `aeb8e3c3`. The
reader now verifies both blobs and descriptor size before canonicalizing the
config identity; platform, full layer list, all config fields and labels remain
strict. Local legacy/OCI/config-corruption and promotion controls pass. The
release can reuse the successful package checks only after verifying that run's
steps and exact unchanged application/dependency/runtime/schema source paths;
all changed operations and browser checks still execute. Checkout supplies the
source history without retaining credentials or requiring an unauthenticated
private-repository fetch. No application rebuild
qualification or native fixture is being inferred from a different image.

Run `42370052315` passes the unchanged-source proof, 709 operations / 11 schema /
16 Kubernetes checks and the browser fixture, but image preparation then refuses
`DELIVERY_IMAGE_RAW_CONFIG_UNVERIFIED`, still before rollout. A registry-read-only
promotion inspection mode reproduces the exact local label build on the hosted
engine without publishing, accessing Kubernetes or modifying business data.
Inspection `42370603240` verifies the published image, then proves the promoted
image is an OCI index. Resolution now requires one exact observed-platform
manifest and verifies index, manifest and config hashes/sizes before the existing
qualification checks. Duplicate platform matches, wrong platform and changed
manifest bytes/descriptors are rejected by added tests. Hosted inspection
`42370741371` at `2149ccb` then passes both the exact published image and actual
label-only promotion, including full config/layer qualification and private
credential removal; no publication or production call is part of that probe.

Release `42370866668` passes 710 operations / 11 schema / 16 Kubernetes checks,
the browser fixture and immutable publication. Runtime `077b06ed` and frontend
`38b4b105` are published. Rollout then fails `UPDATE_IMMUTABLE_IMAGE_REQUIRED`:
the new coordinator called the runtime-only Pod drain validator for frontend.
Its first frontend rollback hit the same validator and interrupted later restores.
Read-only inventory is being collected before recovery; no unchanged-state claim
is made. The Pod validator now requires the correct frontend/runtime repository
while retaining exact controller ownership. Rollback attempts every owned target
and reports any unconfirmed restoration; added tests cover both regressions.
Inventory `42371789449` confirms all ten workloads ready, four runtime targets on
`077b06ed`, frontend restored to `32f26e92`, and unchanged `8f82c881` schema catalog.
Its temporary client and credentials are removed. Recovery now pins exactly that
observed image baseline, while retaining the original `ada21f57` schema ledger.
Twelve Pod/ownership controls and six pagination-release controls pass locally.

Release `42372009157` passes 712 operations / 11 schema / 16 Kubernetes checks,
image publication and all five workload drains. Public acceptance rejects the
runner-build/index comparison (`FRONTEND_PUBLIC_BUILD_MISMATCH`). All five images
are restored and drained successfully; rollback reports no failures. The actual
published frontend image contains `index-37E7Vfml.js`, while the independent
runner build contains `index-Bbh5inT-.js`. A never-started local image inspection
confirms the different index hashes. Acceptance now extracts the exact immutable,
source-labelled image assets, browser-tests those bytes before rollout, and
compares every public code asset against that verified artifact. It no longer
assumes byte-identical output from the two separate build environments.
The actual immutable frontend image passes local Chromium: 1,201 job summaries
in three requests, no full job startup reads, all existing history/failure checks.
Its index SHA is `aaa576da` and 55 public code assets are bound. Three archive
boundary tests and all six pagination-release controls pass.

Release `42373358926` passes 715 operations / 11 schema / 16 Kubernetes controls,
image-asset browser acceptance, all workload drains and public HTML/JS/CSS hashes.
The separate PDF browser probe still selected the independent runner dist and
failed; all five images are restored with no rollback failures. The verified
image asset directory now propagates to that PDF probe as well. Application and
runtime sources remain unchanged; only that exact browser-probe file is allowed
alongside operations changes when reusing the prior package gates.

Owner's latest operating rule: stop any Actions run exceeding three minutes and
resolve the delay. The completion workflow now has a three-minute job deadline;
its coordinator has a 90-second work deadline and 30-second rollout/drain bounds.
It retains the verified runtime `077b06ed` and changes only frontend to the already
published `b2201c24` image. No rebuild, publication or runtime restart is needed.
Both prior full application gates and the 715-operation run are checked through
GitHub metadata and exact source comparisons; only the enumerated completion
scripts/browser probe/docs may differ, and their targeted controls run again.
The runner's installed Chrome is checked and used instead of downloading another
browser. Actual local Nginx-image PDF extraction now passes with the verified
image asset reference, alongside the 1,201-job image-browser test.


## November 5 — latest integration checkpoint

**Application release42031298536 passed on main8874111.** PR28–32 are merged.
Both application packages pass3,488 backend and380 frontend tests, typechecks
and builds;700 operations,11 schema-helper and16 Kubernetes checks pass.
The27-migration manifestada21f57 is applied atomically; exact image/schema and
configuration readback, old-process drain, public checks and both cleanups pass.
Deployed runtime is9a94ce1a, preserving the qualifiedf2d0f9 native filesystem.
The original inventory baseline and all failed attempts remain retained.

At6c469c5, rollback42028955332 passes exact full SQL and catalog restoration;
restore42029295368 and interrupted retirement42029747879 each pass13 actual
checks and cleanup forada21f57. These finite scopes do not establish arbitrary
capacity or general recovery objectives.

The one authorized current request **did start**, but it ended with
`AI_AGENTS_UNAVAILABLE`: all 12 successor jobs failed about 60.652 seconds after
acceptance; persisted issuance closure was at 60.658012 seconds. No proposal file issued. Request workflow42034910171 failed its
response guard; private after-commit proof and read-only inspection42036499094
establish the exact successor separately. Historical results and unknown usage,
the one-send marker and all cleanup proofs remain intact. No request replay or
additional model campaign was started. The retained attempt was skipped before
send with `PROVIDER_QUOTA_WAIT`; this is not a fresh provider availability test.
See [the request followup](evidence/current-request-followup-20261105.json).

The harness correction now tests actual persisted command-response chunks:
admission attaches the issuance ID after the captured command result. Browser
successor checks remain strict; the parent binds the issuance ID from the exact
current database proof before observing completion. Focused checks pass: 23
request/11 issuance Python controls, 36 TypeScript/exact-SQL tests, four actual
local Chromium controls and five read-only recovery tests. The recovery
projection now includes persisted/effective issuance clocks; hosted followup
42037659578 passes at a4a3e95 with exact request/actor/clock/runtime matching
and cleanup. It confirms `AI_AGENTS_UNAVAILABLE`, persisted closure after
60.658012 seconds and zero proposal versions. All 3,491 backend tests across
206 files, typecheck and build pass at a4a3e95. Frontend production sources
are unchanged from the 380-test release gate. Provider availability, private semantic/retrieval holdout, automatic
Arabic OCR and actual Word TOC update/save remain open.

## November 4 — current integration status and remaining release gates

This is a historical November 4 checkpoint, superseded by the November 5
checkpoint above. At this earlier anchor the implementation was **not deployed**. The permanent
GitHub Actions → DigitalOcean access runbook is merged on `main` through PR25;
the current reliability implementation is still draft PR24.

- Both lockfile installs pass. Final frontend typecheck, **359 tests / 57 files**,
  and build pass. The combined backend suite on committed source `c9f1c5b`
  completed with 2,889 passing tests and two stale assertions. Both assertions
  are corrected; their focused suites pass 32 and 24 tests respectively.
  The [combined diagnostic receipt](evidence/combined-backend-diagnostic-20261104.json)
  retains the red run; the complete final source still needs a green run.
  Combined operational checks pass: 391 tests, plus 11 schema-helper and 15
  Kubernetes-render tests. Final runtime changes still require their own checks.
- Native canonical DOCX verification now runs in a bounded subprocess. The
  actual continuous worker passes two consecutive two-volume jobs at its
  unchanged 640 MiB / one-CPU limits, with concurrent transport/health checks.
  Earlier second-job OOM failures remain recorded. The API's 64 MiB verifier
  child passes the seven-fixture matrix at 384 MiB / one CPU, but its measured
  container peak leaves no established headroom. Exact 700m CPU, larger admitted
  bounds and early concurrent-file admission still require qualification.
- The final representative visual receipt covers **18 DOCX / 91 PDF pages**,
  with exact prior reviewed-page hashes and fresh native field/content checks.
  LibreOffice TOC page numbers and actual Word update/save are separate limits.
- Storage one-time send authorization, unknown-write accounting, deletion
  receipts, request cancellation and independent replay/current-clock regressions
  are integrated. Five real PostgreSQL lock-observed cases and 25 retirement SQL
  cases pass. The pinned Storage/Nginx binary qualification passes 14 cases and
  38 routing variants. Retirement/recovery and exact gateway release guards are
  integrated; no production retirement or checked gateway rollout has run.
- The 600-second request deadline and early no-agent failure are implemented.
  Local exact 22-migration PostgreSQL restore passes eight checks. The first
  cloud Auth/Storage drill failed at fixture-user setup; the second failed at
  private-bucket setup. The third drill passes all 13 actual HTTP acceptance
  checks and both cleanups after correcting the isolated bucket limit. The
  fourth drill repeats all thirteen checks successfully using the source-bound
  shared platform Auth helper. Production catalog metadata still confirms Auth
  RLS blocks application-owner reads despite SELECT grants; deploying that
  qualified helper remains required to repair production.
  Full hosted package timing, deployment and actual user-flow acceptance remain
  unproven. An optional template is not successful issuance.
- The latest read-only model binding audit is successful run41869042836;
  it reports no Gemini key and existing OpenAI/QwenCloud keys. The earlier live
  campaign's credit/quota failures remain unresolved evidence, not semantic
  success. G09 offline paired-field tests pass with explicit scope and seven
  bounded-retrieval misses retained. Automatic Arabic OCR and private semantic
  holdout are still open.

The evidence files referenced by the detailed entries retain their exact scope
and source hashes. Historical failures are retained rather than relabeled.

### November 4 — actual cloud Auth and Storage restore passes thirteen checks

[Run 41908346634](https://github.com/salahassi/tenders/actions/runs/41908346634)
at `fb43a7a3d54518b98cadbfc344d9c1ad4b6766f4` passes all 13 actual Auth/Storage
HTTP acceptance checks, the twelve helper guards, original cluster CA checks,
isolated resource cleanup and temporary credential cleanup. The
[sanitized receipt](evidence/cloud-restore-20261104-41908346634.json) binds the
same frozen 22-migration manifest and source catalog as the previous attempts.
It proves exact restored file bytes, owner access and former-owner denial,
revoked review/assurance state and replay without duplicate history or usage.
The corrected isolated bucket matches the service's actual 1 MiB file limit.

This run uses the earlier fixture-specific Auth policy, so it does not qualify
the subsequent shared production Auth helper. No customer rows were copied,
production business records or Auth policies changed, or model calls made.
The application renderer was not exercised. A fresh shared-helper drill,
production release and full hosted issuance remain required.

The subsequent [run 41910306855](https://github.com/salahassi/tenders/actions/runs/41910306855)
at `28689b97503b1fe23f0999909c91427867131c91` repeats all thirteen checks
successfully with the **shared source-bound platform Auth helper** and refrozen
manifest `9e3430d1d01af222e3aad0d4aa8cae5e1f0c14942ae0ff258f0a96f6f953e020`.
Original cluster CA verification, twelve local guards and both cleanup stages
pass. Its [receipt](evidence/cloud-restore-20261104-41910306855.json) establishes
the shared helper's isolated Auth/Storage behavior, without copying customer
rows or changing production Auth policies. Renderer capacity, actual production
policy repair and hosted full proposal issuance remain separate release gates.

### November 4 — frozen schema and gateway contract for the isolated cloud drill

The initial 22-migration manifest was committed at
`backend/scripts/ops/proposal-delivery-release.json`, canonical SHA-256
`8de17c4f4a3f625259c8f0318e0d51d5f344e607aecbcd737923f7e3e765a58e`.
Its baseline is the sanitized inner receipt of successful inventory run
41881660683; it binds the qualified gateway before/after configuration and
pinned-binary receipt. Local freeze and source verification pass.

This permits the reviewed `doks-access.yml` **mode=restore** drill on the
published committed checkout while runtime work continues. That drill copies
catalog metadata only into a nonce-owned isolated database and exercises actual
Auth/Storage with synthetic fixtures. It does not deploy application images,
copy customer rows, invoke models or qualify the application renderer.

The first hosted drill, [run 41902822255](https://github.com/salahassi/tenders/actions/runs/41902822255)
at `9eca6830915bab05af23e278449609c0d8926ecb`, failed with
`RESTORE_RPC_CLOUD_RESTORE_FIXTURE_USERS_FAILED` and
`AUTH_STORAGE_HTTP_ACCEPTANCE_FAILED`. Original cluster TLS and the eight local
guards passed; isolated resource cleanup and temporary credential cleanup both
passed. The [sanitized receipt](evidence/cloud-restore-20261104-41902822255.json)
retains this failure. All 13 HTTP acceptance checks remain unproven; fixture/API
diagnosis and a fresh successful drill are required.

The corrected [run 41905235686](https://github.com/salahassi/tenders/actions/runs/41905235686)
at `8b583cb9c3936f7bb004f466ab7908e8362ef4ad` passed fixture-user setup and
failed at `RESTORE_PRIVATE_BUCKET_CREATE_FAILED`. Original TLS, twelve helper
checks and both cleanup stages passed. Its
[sanitized receipt](evidence/cloud-restore-20261104-41905235686.json) also
records the actual production Auth catalog: the application owner is neither
superuser nor BYPASSRLS, has SELECT but no effective ownership or applicable
SELECT policy on RLS-enabled `auth.users` and `auth.identities`. This is a
confirmed production authority gap, not merely an isolated-test mismatch.
A narrow source-bound platform policy correction is required; no production
Auth privilege or policy mutation has yet been made.

The actual worker steady-state test remains **failed**: the temporary 256 MiB
parent-heap cap completed the first two-volume job in about 113 seconds, then
the unchanged 640 MiB container was OOM-killed when starting the second job.
Native verification process isolation is being implemented and independently
reviewed. The earlier single-job capacity results do not close this gate; final
combined checks, image qualification, rollout and hosted issuance are pending.

## November 4 — historical recovery transitions qualified at current schema

G13 now has twelve additional public-command integration cases combining paid
candidate/report/prompt state, exhausted verification budgets, accepted sibling
work and the current issuance contract. Eligible terminal/expired unknown usage
can be retried with a new explicit 600-second authorization while old request,
usage, graph and source rows remain unchanged. Active ambiguity, manual policy,
forged terminal provenance, stale source and revoked membership are denied with
no hidden authorization or allowance change. A historical delivery contract
requires explicit cancel/successor creation; its paid history stays immutable.

The operational resume test now distinguishes its deployed November 3 boundary
from the fully migrated refusal policy. It applies the later migrations as the
managed owner and proves both current retry routes refuse the old contract.
No production implementation, prompt, routing, billing policy or recovery budget
changed. The helper's historical fixture setup precedes every paid receipt.

Fresh local evidence on runtime baseline `c3f3693`: **328 focused Vitest cases**,
**three operational Python tests**, **two real PostgreSQL command cases**, and
backend typecheck pass. The focused count includes **43 historical wire hashes**;
it is not a full-suite result. The complete migration hashes and scenario-level
coverage are in [the historical recovery qualification](HISTORICAL_RECOVERY_QUALIFICATION.md).
The two PostgreSQL cases are sequential command integration, not race evidence.
Both dependency trees reuse the coordinator's exact lockfile installation;
no broad package or frontend rerun was requested for this test-only change.
Deployment, hosted/provider-specific recovery, the coordinator's final combined
suite and other workstreams' semantic/artifact acceptance remain separate gates.
No external model, storage, payment or production operation ran.
## November 4 — reviewed Word fields and supported content shapes hardened

The bounded verifier now checks complete complex-field instruction sequences
(begin/instruction/separate/end) and equivalent simple fields. It permits native
TOC switches, footer PAGE, and local TOC page/hyperlink references bound to actual
canonical heading bookmarks. Split instructions are combined before checking.
Dynamic/external fields and imported content containers are rejected, including
empty cached results that could introduce content after Word refresh. A PAGE
field cannot replace authorized footer text; a TOC field must close inside its
own content control and cannot absorb a canonical table.

Explicit active `vanish`, `webHidden` and `specVanish` properties are rejected,
including styles. Disabled values remain accepted. Supported body/footer parent
relationships prevent foreign/undefined wrappers from contributing text, yellow
highlight, fields, tabs, breaks or native hyphen characters that Word could
ignore. These are explicit supported-shape checks, **not full OOXML schema
validation or a guarantee against every possible visual styling effect**.
Tables and TOC controls are anchored to their canonical preceding nonempty body
paragraph count, preserving the position of blank tables as well as existing
row/cell/grid/ragged-table checks. The added large-model anchor pass yields to
existing asynchronous cancellation; no deadline or caller interface changed.

Local red/green evidence: **22 newly specified cases fail against verifier
`faf1f33`** (20 unsafe acceptance cases and two valid Word compatibility cases).
The final source passes **105 focused cases across six files**, including all
47 bounded-verifier cases, plus backend typecheck/build. Native and Word-style
TOC/PAGEREF/HYPERLINK, split instructions, simple PAGE, zero/Arabic/yellow gaps,
namespace aliases and disabled hidden properties retain positive controls.
Tests use the exact corrected renderer from **178eb04**; its two frontend files
were copied only as local test dependencies and are excluded from this commit.

Evidence and source/log hashes are in
[`evidence/docx-field-qualification-20261104.json`](evidence/docx-field-qualification-20261104.json).
The pre-correction sparse capacity artifact still contains an `undefined` footer
wrapper and is not relabeled as final-source capacity acceptance. Final dense
capacity, alternating-direction expansion, native Word/LibreOffice visual review,
combined package checks and hosted acceptance remain separate coordinator gates.
No provider, production, payment or external storage call ran.

## November 4 — complete bounded generation-context diagnostics

Generation now runs independent context checks after repairable base validation
failures, covering section identity, structure/blueprint rules, detail scope,
review references and commercial section/requirement/rate references. Only the
three declared validation error codes with typed diagnostics are collected.
Malformed schemas, unexpected exceptions, missing prerequisites and terminal
policy/template/approval errors still stop immediately. The first validation
code and retry metadata are preserved; no workflow or source pin changes.

Unknown aliases are enumerated across every typed field before any canonical
object is constructed. Failed expansion can still report independent raw
metadata errors, using explicit metadata-only checks that never return
ownership or repeat the rejected requirement references. Virtual structure
paths are projected before deduplication and the 32-diagnostic cap, preserving
the exact omitted count. Valid ownership, evidence checks and result objects
remain unchanged; failed candidates are never accepted or saved.

Local evidence: **205 focused tests across eight files**, including **18 new
context cases**, and backend typecheck/build pass. The cases include 300
commercial failures (32 retained, 268 omitted), 40 review failures plus one
independent base failure (32/9), 40 unknown aliases plus a reserved key (32/9),
and 64 virtual structure paths after deduplication (32/32). Both lockfiles were
installed. Frontend typecheck and **329 tests across 53 files** pass; its build
hit shared-workspace `ENOSPC` before artifact creation. The broad backend run
was stopped for coordinated resource use after known integrated fixture
failures; it is not recorded as a full pass. The coordinator owns the single
final combined package run after the pending integrations. No production,
model, provider, email or workflow-dispatch call was made for this change.

## November 4 — Owner resolves D06 and the maximum issuance deadline

The Owner requires immediate clear failure when no AI agent is available and a
600-second maximum from request acceptance to issuance, including queue/stages/
repair/render. Earlier terminal failures return when known. This supersedes the
mandatory staffed no-model completion acceptance; optional manual authoring remains
independent. The plan, BC-01/T06 and decisions now reflect that instruction. The
model/executor agent is implementing the shared deadline/fail-fast contract with
artifact and release coordination. No deadline deployment or timing acceptance is
claimed yet. Historical/unknown accounting and accepted source/content remain intact.

## November 4 — actual uploaded OCR quality gate found Arabic recognition loss

Three committed synthetic PDFs and pre-authored English/Arabic obligation oracles
exercise the actual native OCR image with network disabled, 768 MiB, one CPU and
64 PIDs. The explicit native suite fails if the engine or Arabic data is absent;
it is separate from ordinary JavaScript tests that have no native engine.
English obligations/numbers/dates, exact mixed-PDF page selection/blank handling,
and original-hash/page-count rejection passed. Arabic recognition **failed**:
the first obligation was omitted and critical words were damaged. The frozen PDF
and oracle were not weakened after this outcome.

The same image reported confidence **82** and `numeric_uncertainty=false` for
that damaged Arabic text. This is concrete evidence that neither signal can
confirm complete extraction or preserve semantics. The exact sanitized evidence
is [`evidence/uploaded-ocr-native-20261104.json`](evidence/uploaded-ocr-native-20261104.json).
An earlier real-image startup failure due to root-owned package COPY permissions
was fixed in the OCR implementation branch; its new image was used for this run.

W02/T04 remain open for automatic Arabic quality. The implementation agent is
adding current-source visual review and immutable authorized page corrections;
an OCR failure must not label a valid original RFP invalid or erase readable
pages/accepted history. Native image/code integration, human-correction acceptance
and hosted OCR delivery remain separate pending gates.

## November 4 — frozen bilingual semantic development campaign

Implementation: two explicit live-evaluation suites now cover eight independent
faithful/mutated semantic families in English and Arabic (32 cases total).
Gold is excluded from provider input, corpus bytes are pinned in both entrypoints,
and the canonical format pin, prompt and grounding validator run before scoring.
Exact targets come from the enabled catalog. Each language is bounded to four
targets/64 generation calls and one attempt per case; failures and unknown usage
are retained. This changes evaluation tooling, not product call/billing policy.

Local evidence: **21 Python evaluation guard tests** pass and **30 tests across
five evaluation suites** passed before the final additional short-span oracle
case; the updated semantic suite passes **5/5**. Provider transport is mocked.
The independent oracle review and exact frozen scope/thresholds are recorded in
[`SEMANTIC_QUALIFICATION_CAMPAIGN.md`](SEMANTIC_QUALIFICATION_CAMPAIGN.md).
No live evaluation has run for this corpus yet. This is development qualification,
not closure of private holdout D07, all-task ME-08/14, or production acceptance.

## November 4 — hosted inventory and original-CA access verified

[Run 41841720671](https://github.com/salahassi/tenders/actions/runs/41841720671)
completed successfully on `7b8808174fbf62d53364e56084102a901bc1338d`.
The original cluster CA/hostname checks, inventory read and temporary client/credential
cleanup all executed successfully; every bootstrap step was skipped. All ten owned
application Deployments had one desired/ready/updated replica and observed current
generation. No business/schema/model operation ran. The exact sanitized receipt is
[`evidence/digitalocean-inventory-20261104.json`](evidence/digitalocean-inventory-20261104.json).

There is no canonical migration ledger on this database; six named application
release receipts are present, ending with the November 3 prompt-identity and
model-admission-fairness releases. Delivery snapshot/artifact tables and executor3
are absent. This confirms the new implementation is not deployed yet. API/worker
use image digest `85799a61eaeed29f967f51fc7c9c83263d07e28c9053941663a396604ae60380`;
image source revisions remain independently unverified. This is a current baseline
for a guarded release, not hosted proposal/model acceptance or schema-tip proof.
## November 4 — G12 footer correction independently requalified

A fresh actual-render/verification run on integrated source `b3b1380` produced
**18 DOCX files and 91 PDF pages** with the exact committed footer renderer
`fc69fef`. Every page was inspected again. Correct footer page numbers are now
neutral; zero yellow footer drawings were found. All expected gap labels remain
visible and yellow, with unchanged payload/model hashes and page counts. The
source/DOCX/PDF/page hashes and separate visual review are retained in
[the G12 report](DELIVERY_VISUAL_QUALIFICATION.md).

Native TOC page-number results remain absent in LibreOffice direct conversion;
Microsoft Word update/save is untested. This is an explicit compatibility gap.
The later dense-input renderer capacity investigation changes source after this
run and needs final output comparison or requalification. No production, model,
hosted-storage, universal input-size or 600-second delivery claim is made.

## November 4 — G12 initial all-page document qualification

The actual integrated renderers 1/2/3 produced **18 verified DOCX files** from
12 synthetic Arabic/English, combined/separate-volume snapshots. All **91 PDF
pages** were inspected across 20 labelled contact sheets, with full-page checks
for field defects. Long tables (40 technical and 32 financial rows), all seven
typed gap reasons, renderer-3 inline/table placeholders, zero values, Arabic
direction and repeated headers remained visible without observed clipping or
overlap. Payload/source/DOCX/PDF/page/contact hashes and explicit visual review
are recorded in [the G12 qualification report](DELIVERY_VISUAL_QUALIFICATION.md).

**Initial result: corrections required.** LibreOffice does not display TOC page
number results and renders footer PAGE results yellow across every fixture.
The shared renderer correction and a fresh all-page rerun remain pending;
some sparse gap-only final pages are a minor observation. Backend typecheck and
Python compilation pass for the reproducible fixture/page tools. Existing full
package gates remain the prior operations evidence below; the coordinator owns
the final integrated checks. This is synthetic layout evidence only: no model,
production, hosted download, Microsoft Word or 600-second issuance claim is
made. Initial artifacts are preserved before any field correction.

## November 4 — isolated release reconstruction and recovery gate

The explicit `doks-access.yml` **restore** mode uses the established original-CA
runner route. It reads only the actual managed application catalog and verifies
either the frozen six-release baseline or the exact final release/catalog pair.
The baseline is reconstructed under nonce roles in a disposable database, then
the complete hash-verified additive batch is applied there with only managed
role names rebound. Unexpected legacy roles fail closed. The production source
supplies no customer rows. Raw definitions stay private in bounded Secret chunks
with a concatenated SHA-256 check; setup, schema, HTTP acceptance and cleanup
remain separate failure boundaries.

The drill uses real isolated Auth/Storage and ordinary public backup/restore
functions. Synthetic source rows and file bytes are backed up before a guarded
fixture reset. Exact database/comment/source identity, a frozen table allowlist,
and trigger fingerprints constrain that reset. An injected FK failure proves
transactional rollback restores rows and trigger state. The application singleton
workspace constraint is retained: only after removing the synthetic source does
canonical bootstrap create the second verified Owner's new target workspace.
Restoration retains original file hashes and historical source confirmations,
adds current-Owner revocations, clears live requirement assurance, denies the old
Owner, preserves idempotent replay and invokes no model. Storage fixture bytes
are explicitly separate from actual application renderer acceptance.

Local evidence: **319 operations tests**, **11 schema tests** and **eight real
PostgreSQL reconstruction/recovery checks** pass. The PostgreSQL receipt records
all **16 currently integrated additive migrations**, including renderer version
3 and restored-source assurance, under a non-superuser managed owner. Its Auth
and Storage schemas are stubs; actual cloud HTTP/bytes remain pending. The
PostgreSQL harness now waits for the final PID-1 postmaster, avoiding the official
image's temporary initialization-server readiness race. The release workflow
explicitly discovers the schema tests in their hyphenated directory.

Deployment, cloud restore and 600-second hosted issuance remain **unverified**.
No production dispatch/mutation, external model or email call was made here.
The final reconstruction must be rerun after the remaining ordinary-export
migration joins the release. Existing package gates from this operations slice
(backend 2,156/131 files; frontend 299/46; both typechecks/builds) are unchanged;
the coordinator owns the final integrated package and hosted gates.

## November 4 — managed catalog reconstruction and native entrypoint guard

The schema reconstruction builder accepts an explicitly named managed source
role family and maps only those reviewed roles to the isolated target family.
It preserves column-only grants without broadening them to table SELECT; unknown
roles, grantors or column privilege kinds fail closed. **11 schema tests** pass,
including capture from an actual managed-role PGlite catalog and reconstruction
in a second isolated database. Actual queries confirm metadata-only reads,
protected payload/private tables, outsider/anonymous denials, authorized context
RPC access and separate service authority; no role gains superuser/BYPASSRLS or
cluster-level create privileges. This prepares cloud restoration; it does not
claim that an isolated cloud restore has run.

The release also privately checks that the native OCR container is the expected
`ocr` identity and has no command/argument override before any SQL or image
change. Otherwise the new image's fair worker entrypoint might never execute.
A fixed error blocks that condition without exposing the command or arguments.
**Eight rollout tests** pass, including each override variant; the actual five-
minute schedule and resource baseline come from the coordinator's fresh receipt.

## November 4 — final renderer and worker-floor release capabilities

The release manifest now derives its renderer capability set from the exact
reviewed migration sources and includes the separate minimum worker executor.
Image publication and deployment require renderer versions **1, 2 and 3**,
executor **4**, and minimum worker executor **4**. The database transaction probes
actual immutable renderer/executor dispatch for each supported payload version
and requires both canonical issuance requests and their status view before
commit. The final normal-job mixed-claim regression remains mandatory; checking
the local renderer alone cannot prove it. **12 operations release tests** pass
with legacy-six-migration SQL replay still covered and the final runtime gates
exercised by their fault fixtures. Final combined SQL must be rerun after all
phase-2 migrations are merged; the manifest remains absent until that review.

## November 4 — guarded delivery release tooling (phase 2 W11)

Implementation: the new manual-only `deploy-proposal-delivery.yml` verifies a
reviewed frozen migration manifest before credentials or publication, builds or
reuses immutable source-bound runtime/frontend/native OCR images, applies the
entire additive schema batch atomically, drains the previous worker through
`Recreate`, and updates API/source gateway/scheduler/native OCR/frontend in order.
Current non-image specifications, configurations, secrets and native schedules
are retained. The existing application owner executes the SQL without new roles
or elevated permissions. Every original table column/row and existing authority
is compared inside the migration transaction; new tables start empty. Exact
manifest and post-catalog receipts make lost-acknowledgement retry verifiable.
An ambiguous rollout retains compatible code for forward completion and never
automatically rolls back new durable version pins. Temporary client cleanup is
restricted to the exact current run/nonce/owner, including unconditional cleanup.

Local evidence: **12 operations tests** pass, including actual managed-role SQL
batch application/replay and transaction rollback on row or authority faults;
wrong database, ledger drift, partial receipt and post-catalog changes fail closed.
Fault injection covers 11 rollout boundaries, source-image mismatch, concurrent
configuration change, private error suppression, immutable image reuse and exact
cleanup ownership. The final manifest is intentionally not generated until all
phase-2 changes, including the new 600-second deadline policy, are integrated.
The workflow refuses to deploy without that reviewed file and executor-4 source.
See `PROPOSAL_DELIVERY_RELEASE.md` for the concrete coordinator sequence.

Deployment and hosted acceptance remain pending. Neither these tests nor the
aggregate queue timings certify the 600-second request-to-file/error requirement.
Cloud restore, first new native OCR job, real authenticated file download and
actual accepted-request/ready/error timestamps still require their own evidence.
No workflow dispatch, production mutation, model or email call was made by this
implementation. Final package rerun: backend **2,156 tests/131 files**, frontend **299/46**, and
both typechecks/builds pass. Operations **310 tests** and Kubernetes manifest
**13 tests** pass. The last metric extension separately passes its **17 Python**
and **four SQL** cases. Existing frontend bundle/runtime-config warnings remain.
The new global minimum-worker-executor-4 propagation and actual mixed-version
claim regression are mandatory before schema-first release; local render-job
exclusion alone does not close that deployment window. Renderer/payload-3
automatic review-draft capability is also a final integration prerequisite.

## November 4 — canonical issuance timing observations (phase 2 W09)

The optional issuance measurements use the new immutable request contract's
`accepted_at`, `deadline_at`, `completed_at` and outcome, rather than job row
update times. They report accepted-to-issued p95/max, issued-after-deadline,
expired-but-unsettled and invalid 600-second binding counts without identities or
content. The field is null until the issuance migration exists. Isolated SQL
fixtures demonstrate both an ordinary 180-second issuance and a deliberately
late 650-second issuance; the late result is counted as a violation and never
reported as meeting the bound. This is instrumentation for subsequent hosted
measurements, not evidence that the live application has met the requirement.

## November 4 — native inventory defaults correction

The coordinator's extended inventory run `41845129587` passed TLS/readiness but
stopped at `INVENTORY_SCHEDULE_INVALID` before database setup. The first attempt
incorrectly required renderer defaults during observation. Inventory now accepts
bounded actual five-field cron and Kubernetes concurrency values, reports absent
deadline/resources as null and absent backoff as null with effective default six,
and distinguishes explicit from defaulted suspension/concurrency. Field-specific
fixed diagnostic codes replace the combined schedule check. Strict reviewed
baseline matching remains a release responsibility. **17 Python inventory tests**
pass, including alternate cadence and omitted optional fields. Fresh hosted
native evidence is still pending the coordinator's rerun; bootstrap stays gated.

## November 4 — native schedule and queue/capacity observations (phase 2 W00/W09)

Implementation: scoped inventory additionally reads the two owned native
CronJobs, returning only immutable image, bounded schedule/concurrency/deadline,
resources and generation. It rejects a schedule changing during the database
read. Credentials, environment variables and arbitrary metadata remain private.
The same read-only transaction now returns anonymous queue-class counts, oldest
due age, expired leases, delivery artifact reservations and aggregate workspace
storage use. Absent pre-release tables produce null measurements.

Local evidence: **16 Python inventory tests** and **four actual PGlite query
cases** pass. Seeded isolated SQL proves due/future queue separation, retained
expired leases, artifact byte accounting and unchanged rows. The 24-hour
`terminal_row_elapsed_p95_seconds` statistic is explicitly elapsed creation to
last terminal-row update, not a measured first-file or end-to-end delivery SLO.
Counts/ages alone neither certify throughput nor close the capacity gate. No
live inventory, native worker, model or database mutation was run for this
follow-up; the coordinator must capture native baseline images before rollout.

## November 4 — managed-role migration compatibility (phase 2 W11)

Implementation: the six not-yet-deployed delivery/recovery migrations now apply
with either the Supabase role names or the existing DigitalOcean `tdp_app_*`
roles. Five files required conditional ACL/policy corrections; the company
retrieval migration already handled both families. The policy expression and
service-only RPC boundaries are unchanged. No role is created or promoted, and
no live database has been modified. Their final release hashes must be generated
after integration, rather than retaining the earlier local source hashes.

Local evidence: **74 tests across four files** pass, including a full migration
batch under a non-superuser, non-BYPASSRLS `tdp_app_owner` with all three legacy
roles absent. A historical blocked job is byte-for-byte unchanged, current
members can prepare/read the draft package, browser-role reads of private
payloads and service RPC execution remain denied, and the managed service role
can claim/reserve the local artifact. Existing delivery, snapshot and document
coverage tests pass with the legacy role family. Backend typecheck passes.
The earlier full package checks remain applicable to runtime code;
production migration and hosted acceptance remain pending coordinator rollout.

## November 4 — scoped runner inventory mode (phase 2 W00)

Implementation: manual `doks-access.yml` runs now default to `mode=inventory`.
The established one-hour kubeconfig, original cluster CA and hostname checks
remain in place. `mode=bootstrap` explicitly retains the prior isolated
compatibility workflow, as does its existing dedicated branch push trigger.
Both bootstrap cleanup paths are mode-gated; inventory cannot accidentally invoke
them. Checkout includes the helper's reviewed dependencies and workflow tests.

The inventory reads only owned application deployments, observed image digests,
Kubernetes revisions/readiness and read-only application catalog/release receipts.
It rejects workload image/generation changes across the catalog read. Missing
canonical migration history remains unknown rather than being inferred from a
historical receipt. Image source commits are explicitly uninspected, separate
from the runner source revision. Raw manifests, credentials, database exception
bodies, function source and customer content are withheld from public output.
Only validated fields and allowlisted release names are emitted.

The database read uses the existing nonce-owned temporary client with full
managed-database TLS verification; it creates no bootstrap database/roles and
executes no business, migration, model or notification command. A private
current-run cleanup journal permits the unconditional workflow cleanup to retry
the exact client/Secret cleanup after a failed or interrupted helper. Foreign
run names, altered ownership or permissive journal files fail closed.

Local evidence: **14 Python inventory guard/redaction/lifecycle tests** and
**three actual PGlite catalog-query cases** pass. The latter verify target-database
rejection, optional historical ledgers and absence of routine source in receipts.
Both lockfile installs, typechecks and builds pass; the existing **2,151 backend
cases/129 files** and **299 frontend cases/46 files** pass, with the three new
catalog cases separately verified. Existing frontend bundle/runtime-config and
`whatwg-encoding` warnings remain. No external workflow, Kubernetes call, model,
production database or email operation was performed by this implementation.

Run only after the reviewed branch is published:
`gh workflow run doks-access.yml --repo salahassi/tenders --ref codex/reliability-v2-operations -f mode=inventory`.
The release coordinator may use the reviewed integration ref containing this
change. Hosted current-state evidence remains pending that actual run; W09/W11
capacity, measured latency, isolated cloud restore and rollout gates remain open.

## November 4 — W08 phase 2 consistency and targeted evidence core

Core implementation in progress: a versioned proposal consistency report binds
actual response excerpts, method, deliverable and acceptance evidence to each
requirement; source semantics and current authorized human review remain separate
from deterministic text identity. Explicit shared quantity/currency/date/decision
bindings are compared using Decimal strings; unknown is distinct from zero.
Source restatement and repeated headings/forms cannot establish completion.
Targeted company follow-up scans omitted frozen verified sources, retains exact
paragraph coordinates and distant detected qualifiers, and exposes unresolved
coverage. Partial sources are discovery context and cannot establish company claims.

Local core evidence: 29 focused tests pass; backend typecheck passes. Actual
generation/approval integration, authorization/currentness integration tests,
full suites and deployment are not yet complete in this core commit. Bilingual
retrieval aliases are bounded hints, not semantic authority or an exhaustive
recall guarantee; unbounded source paragraphs retain an explicit capacity gap.

Generation integration now applies the targeted pass only under a new frozen
`company_followup_version:1`; both graph input and independent whole-source
validation retain partial company evidence as unverified discovery context.
The full parent reference remains in the authorization manifest. New assembly
persists a versioned substantive report and finalization gaps without discarding
draft sections; model `answered` labels cannot certify the human review. Snapshot
wrapping preserves every prior pin and its absence. Local focused integration:
59 tests across four files pass, including exact parent authorization, source
revocation, late overflow evidence, partial-claim rejection and draft assembly.
Normal proposal review/approval route, complete suites and deployment remain open.

Independent review tightened the core before acceptance: numeric values now bind
to complete numeral tokens, declared units and currencies must occur in the
response quote, and unspecified input completeness blocks substantive completion.
Explicit source-index/quote-hash to response-quote equivalence mappings permit
reviewed Arabic/English qualifier paraphrases; model or anonymous equivalence
cannot pass. Numeric assertions outside the primary requirement response need
reviewed section bindings, and explicit financial bindings compare the current
Decimal calculation. Targeted discovery now preserves every full source admitted
by the first pass before using remaining bytes; partial spans cannot evict
complete priority proof. The latest focused run passed 72 tests across five files.
These integrity checks and scoped human reviews do not establish exhaustive
semantic truth or prove cross-language recall; independent qualification and
production evidence remain separate.

Normal proposal review and approval integration is implemented locally. A usable
scoped review panel records actual response excerpts, implementation method,
deliverable, acceptance evidence, preserved/equivalent qualifiers and explicit
shared numeric/date/decision bindings. The API computes the report from server
content and authenticated identity; client pass flags are rejected. The service
commit rechecks workspace role after locking, source/authority/material currentness,
actual section rows, current Decimal calculation/delivery records, expected
revision and actor-specific idempotency. A superseded review cannot replay as
current. The approval wrapper retains every prior blocker and binds its review
hash to the accepted current report. Initial draft assembly remains deliverable.
New report/review columns use the existing version backup/retention contract;
restored history cannot bypass current role/source checks. ACL handling supports
both Supabase and managed DigitalOcean role families.

Local evidence: 83 focused tests in six files pass, including a real migrated
source-authority inventory through service review and actual final approval,
source/body/member/revision/calculation change rejection, full-proof retention,
partial-claim rejection and API trusted-report denial. A 64-test assessment/review
regression passed after correcting function-qualified parameter labels in the
renamed generation delegate. Both package typechecks and builds pass; all 301
frontend tests in 47 files pass. The standalone full backend run with W05's
copied migration but without its runtime/test integration reported 2,168 passing
and 36 failing tests: source-contract fixture/runtime mismatches, the subsequently
fixed generation-wrapper label regression, and one historical migration timeout.
Combined W05/W06/W08/W10 full backend validation remains a root integration gate;
this entry does not claim that gate passed. No production or paid model call was
made. Ordinary final approval still requires explicit current human review;
that does not wait inside generation or mask provider-unavailability errors.

Automatic generated-delivery validation now has a separate pure machine gate.
It reconstructs the canonical final assembly (including planned parts, fixed
blocks and generated matrix), compares actual saved rows/outline, and requires
matching accepted candidate and complete verifier receipts for every completed
model step. Existing grounding and numeric evidence checks are reused; source
restatement, generic compliance, empty/title-only content, missing response
coverage, known quantity/unit mismatch, blocking review findings and absent
cross-section reconciliation block issuance. Human authority/meaning/finalization
review gaps remain explicit and do not masquerade as machine failure or human
approval. The returned payload always remains draft and substantively incomplete.
Nine isolated machine fixtures pass; actual publication/lease/deadline/renderer
integration is owned by W10 and remains a combined gate.

Core applicability handling now retains every inventory row with explicit
`excluded/non_obligation` or `excluded/approved_not_applicable` classification and
reason. Informational or confirmed nonbuyer sources require the current canonical
source/meaning review reason. Optional buyer offers are never silently exempted;
Owner N/A exclusions must carry the exact current source/content binding supplied
by the existing compliance workflow. Source null actors are allowed only for
reviewed non-obligations. The updated core/review integration subset passes 57
tests; the W05 binding migration and UI integration are separate follow-up work.

The applicability integration now accepts explicit excluded inventory rows only
when the server context supplies the canonical current non-obligation meaning
review or existing Owner N/A approval binding. A fabricated excluded status does
not satisfy the service guard. The normal review UI shows pending source meaning
accurately, sends the exact observed applicability hash through the existing
compliance command, and requires an explicit reload/review after a stale-source
rejection. It displays excluded rows and their reasons without losing counts.
This composes with W05's separately owned applicability-binding migration.

Automatic draft issuance now also permits a tightly scoped missing company or
commercial input while retaining a real accepted proposed response. The exact
input marker must appear in the body, an insufficient assumption, and the same
requirement's finalization question and supported verifier check; an accepted
proposed-method quote must remain independently in that response. The report
returns `model_checked_with_gap` and the exact visible missing input. Source echo
with an appended marker, absent method, silently omitted requirement, known
contradiction and unrelated question cannot take that path. Service version
volume semantics are compared with the reconstructed assembly. A shared UUID
fixture supports W10's actual database/publication tests; those tests remain a
separate integration responsibility. The bounded marker classifier is not
semantic proof or an exhaustive language classifier.

Latest local evidence: 69 focused backend tests across the core, generated
machine gate, actual review database route and API pass (including all 16 machine
gate cases); all 303 frontend tests in 48 files pass. Both package typechecks and
builds pass. The first frontend rebuild hit shared-workspace disk exhaustion;
removing only generated dependencies/output from the completed phase-1 retrieval
worktree allowed the rerun. Combined backend/source/model/publication acceptance,
real-browser visual QA, native document qualification and hosted rollout remain
root integration gates; this follow-up contains no live or paid calls.

A subsequent issuance-boundary regression reproduced a verifier accepting a
company claim when its original prompt had only partial/unverified discovery
context but the full parent remained in frozen storage. The gate now reuses the
reconstructed task's exact evidence eligibility, including its generated review
source, and never broadens it to all retained parents. Full frozen sources are
used only to check the original requirement citation. The new fixture failed
before the fix; all 17 machine-gate tests, backend typecheck and build pass after
it. Frontend is unchanged from the 303-test/build gate above.

## November 4 — integrated durable draft rendering and independent review

Stages 3–7: six parallel implementation tracks are integrated on
`codex/proposal-reliability-implementation`, with cross-review and separate
regression evidence. The root integration connects immutable delivery snapshots
to executor-3 local jobs, server-side Word generation, byte verification, private
download APIs, current snapshot polling and an independent draft-request action.
A user can explicitly retry a blocked file package with its observed delivery
revision. Changing an opportunity, snapshot or client cancels stale UI actions;
late responses cannot replace the current selection or initiate its download.
Every package remains draft and substantively incomplete. Rendering does not
mark model generation successful, grant approval or settle unknown usage.

Missing inputs are typed placeholders. The canonical document verifier checks
actual Open Office XML text and yellow highlighting, rejects missing highlighting
and yellow confirmed content, and retains the legacy export contract. The new
render projection preserves allowed source content and inserts explicit yellow
review gaps wherever policy-restricted or financial technical-volume content is
withheld. Safe source sentences remain in order; the stored snapshot is unchanged.
Gap counts reflect the actual projection. Financial markers are conservative
review rules, not universal semantic detection or proof of a complete response.

The renderer runs in a fixed offline Deno subprocess with bundled fonts and cached
locked dependencies. It has a 30-second attempt deadline, a 128 MiB old-space heap
ceiling, a 10 MiB input/output ceiling and a 64 KiB diagnostic stream ceiling.
The parent kills and reaps a timed-out process before retrying. Child permissions
allow only font/cache reads; there is no network, environment-reading, file-writing
or child-process grant. These limits are execution guards, not a measured service
latency promise or a total resident-memory guarantee. Uploads use stable immutable
keys and a bounded network deadline; ambiguous upload replies are recovered only
by fetching and verifying actual bytes. Downloads validate all required volumes
before the browser starts either file and recheck current authorization after
reading and verifying stored bytes.

Local evidence: the actual pinned Deno image builds successfully. With network
disabled and a 640 MiB container limit, the reusable renderer smoke test kills and
reaps an infinite CPU loop, survives child heap exhaustion, verifies English and
Arabic files, and verifies a synthetic Arabic document with 1,000 paragraphs and
400 table rows (444,446 input bytes; about 984 kB Word output). Six rendered pages
from the two small language fixtures were visually inspected for text direction,
layout, tables and yellow gaps. These are bounded synthetic samples, not full
Word-client or customer acceptance. The real local pipeline test covers HTTP
prepare through authenticated SQL, executor-3 claim, actual Word bytes, a failed
second volume, canonical retry preserving the first file, full-package download,
and membership revocation between stored-byte read and final authorization. A
separate test removes real yellow formatting and confirms the resulting verifier
failure becomes a blocked SQL receipt without losing saved content.

Final combined validation: **2,151 backend tests in 129 files** and **299
frontend tests in 46 files** pass (2,450 total); both lockfile installs,
typechecks and builds pass. All **281 Python operations tests** and both Node
runtime checks pass. The final integrated PostgreSQL suites pass **17/17**
checks against the same 146-migration manifest, whose SHA-256 is
`40f32caa10ba4f974c86402a83ba39ffb07eaeee37cacd051cc45d99ebbd516e`.
The new artifact migration hash is
`31d9380be786012ddc7bd44103c354ed99728c01640ee1b1ed6b74783061e6a9`.
The isolated database container was removed after receipt retention. Existing
warnings remain for deprecated `whatwg-encoding`, jsdom setup cost and the large
frontend bundle; none is converted into a passing production acceptance claim.

Release status: **not deployed; no paid model, production storage or email call**.
Read-only inventory on November 4 confirmed public frontend/health availability
and the DigitalOcean cluster/nodes running. Kubernetes workload/version reads
returned HTTP 503 through the configured proxy. A fresh read-only diagnostic at
13:16 UTC found identical authenticated and anonymous `/version` failures with
`TLS_error: ... CERTIFICATE_VERIFY_FAILED` before upstream response headers.
This reproduces the cloud container's previously documented direct-access
limitation. **Correction:** the investigation initially missed the established
GitHub Actions runner path in [DigitalOcean Kubernetes access](DIGITALOCEAN_KUBERNETES.md).
Access was already verified on October 25 in
[run 40230328689, attempt 2](https://github.com/salahassi/tenders/actions/runs/40230328689/attempts/2).
The same route subsequently succeeded for
[the November 3 runtime release](https://github.com/salahassi/tenders/actions/runs/41571450550)
and [the following graph diagnostic](https://github.com/salahassi/tenders/actions/runs/41572919737).
The local 503 is not evidence that this solution regressed or that cluster access
requires a new certificate. The current deployed image, application revision and
schema tip were not freshly inventoried through the runner in this implementation;
they remain unverified here because that check was not performed. Historical
success is not current workload acceptance. `AGENTS.md` now requires reading the
established access documentation and selecting a scoped runner workflow before
Kubernetes diagnosis, while retaining original CA/hostname verification. This
correction changes documentation only; no workflow was dispatched, no certificate,
proxy, firewall or production configuration was changed. Local application tests
remain as recorded above; no runtime test rerun is needed for this correction.

OCR for uploaded scans, full source authority/span and semantic repair
contracts, provider-specific semantic/capacity qualification, whole-proposal
consistency, substantive completion during total model outage, measured delivery
latency, storage saturation, cloud restore and hosted upload-to-download acceptance
remain open. The updated remediation plan records each package as partial or open;
this integration does not close all F01–F11 findings.

## November 4 — independent delivery API and UI regression evidence (W03/W10)

Test-only coverage exercises the actual download HTTP handler with a rendered
DOCX and real placeholder, byte-size and hash validation. Six API tests cover
JWT-derived actors despite supplied actor fields, membership/source revocation
after the storage read with no document bytes returned, unready and changed-file
rejection, and package gap totals including policy/volume omissions without
returning source content or storage keys.

Fourteen new frontend tests cover preparing/ready/blocked states, the observed
retry revision, stale package/save/download/retry responses after navigation,
insufficient-input wording, automatic delivery-pointer successors, poll cleanup,
whole-package cancellation, authenticated recovery paths and AbortSignal
transport. Together with eight existing pending-proposal tests, the focused
frontend run passes 22 tests. These tests use synthetic fixtures and controlled
service boundaries; they do not prove live storage/RLS, visual Word acceptance,
provider completion or substantive proposal completeness. The API tests exercise
real application routing and DOCX validation with mocked backend authorization
responses; migrated-database authorization evidence is recorded separately.

Local typecheck/build pass in both packages against the integrated delivery
source copies. Full integrated suite/deployment evidence remains the owning
integration change's gate; no production or provider calls were made here.

## November 4 — early durable delivery foundation (W01/W03)

Stages 3–7: implemented an immutable `proposal_delivery_snapshots` projection
and a separate proposal delivery pointer/revision. Creating a generation plan
now persists a safe draft before any paid-model success; accepting a section
persists a successor retaining accepted siblings and original output, source,
workflow, prompt/schema/verifier and attempt provenance. The ordinary active
version and generation base remain unchanged. Historical acceptance is visibly
`legacy_reviewed`, requires final review, and never asserts new assurance passed.
`delivery.snapshot.prepare` also works without a generation plan or upload;
`delivery.snapshot.refresh` uses current proposal and delivery revisions. A
reported rejected upload is distinguished from server-proven invalid input.
Readable context survives partial failures; insufficient scope produces typed
placeholders. All these snapshots remain draft and substantively incomplete.

Implemented controls: current membership and source checks on content reads,
including unread attachment metadata, service-only actor context, RLS with
metadata-only direct reads, immutable
payload hashes, transactionally deduplicated publication and audit, idempotent
command replay with current authorization, and backup/restore/purge registration.
Historical plan identifiers remain immutable provenance, not live foreign keys
to deletable generation metadata; canonical plan cleanup preserves the snapshot
and its accepted-unit pins. The existing requested-processing deletion test and
an accepted-unit retention regression cover this lifecycle boundary. Automatic
publication is pinned by `delivery_projection_version:1` on new canonical
freezes, preserving absence/version during old-context refresh. It is limited
to active pinned plan inserts; historical/unversioned or canceled/failed/completed
inserts cannot move the pointer, while explicit completed-plan rescue remains
available. Terminal insertion and the canonical verifier-recheck regression are
also covered. The focused integrated regressions pass: **100 backend tests in
5 files**, including requested-processing cleanup and analysis-verifier recheck,
and **19 Python operations tests** across graph diagnostic, recovery and successor
suites. Their historical fixtures remain unmodified; current pinned bad-source
publication still fails closed.
No model-processing consent is treated as blanket local-download authorization.
The existing implementation-plan `delivery.prepare` command is preserved.

Local evidence: **26 new delivery database/contract tests** pass using the full
migration chain in PGlite, including early snapshot versus running plan base,
replay/revision conflict, source and membership revocation, exact accepted-unit
provenance, metadata permissions, and confirmed purge. **43 generation tests**,
**12 flexible-input tests**, **6 operations tests**, and the full recovery test
pass; recovery now explicitly checks immutable snapshot/pointer restoration and
absence of duplicate publication or restored approval. Backend typecheck/build
pass. The isolated `scripts/testing/postgres_races.py` harness also passes
**6 boundary checks on PostgreSQL 17.6**, including 5 contested-write/replay
scenarios with sessions observed waiting on actual workspace locks: duplicate
prepare, accepted siblings, concurrent human edits, source change and membership
revocation. The separate check proves an early snapshot leaves the running
plan's base valid. Repeated prepare retains accepted progress. The image digest
is pinned, networking is disabled, no host port or data volume is published,
and the private receipt records migration hashes rather than customer content.
The harness is reusable against the integrated migration tree; it is not hosted
Supabase Auth/Storage or renderer acceptance.

Deployment/hosted acceptance: **not deployed, no production or provider calls**.
This is the persisted foundation, not a substantively complete non-model route,
DOCX renderer or all-workflow closure. Renderer/API/UI integration, combined branch regression and actual Word/RTL/visual acceptance
remain separate gates in the delivery plan.
## November 4 — explicit recovery for snapshots predating the artifact queue

Implementation: a source-authorized snapshot with neither artifact rows nor
renderer jobs reports a blocked `DELIVERY_NOT_QUEUED` package with no files and
its current delivery revision. This read does not enqueue work. An explicit
`delivery.snapshot.retry` initializes the exact immutable volume set only when
both counts are zero under the existing workspace/proposal lock, current write
role/source checks and revision/idempotency guards. It creates attempt 1 under
the current requester, reserves no storage and records a distinct initialization
audit. Existing partial or inconsistent bundles still fail closed. Historical
snapshots, hashes and payloads are unchanged; no automatic history backfill occurs.

Local evidence: all **45 artifact database cases** pass. Two cases create
snapshots using the foundation migration, then apply the actual artifact migration
and initialize combined or separate packages; repeated reads stay unchanged,
idempotent requests reuse the single bundle, and stale revisions/partial states
are rejected. All **eight real PostgreSQL concurrency cases** pass, including
two simultaneous explicit initializations producing exactly one job/artifact/audit
and one revision conflict, and write-role demotion while waiting preventing any
initialization. Write authority is rechecked after acquiring the workspace lock. Backend typecheck passes. Deployment, integrated full
suites and hosted acceptance remain separate release gates.

## November 4 — delivery verifier failure receipt compatibility

Implementation: `EXPORT_PLACEHOLDER_MISMATCH`, `BUYER_VOLUME_RULE` and
`TECHNICAL_VOLUME_CONTAINS_PRICE` are terminal delivery failure codes. A canonical
verifier rejection now records a blocked package, releases the worker lease and
retains pending storage accountability instead of rejecting the failure receipt
as `INVALID_INPUT`. The immutable draft and its valid-input classification remain
preserved; no ready artifact or model usage is fabricated.

Local evidence: all **41 artifact database cases** pass, including each newly
accepted terminal code; backend typecheck passes. The integration owner also has
a renderer-to-database test using a genuine rendered DOCX with yellow highlighting
removed, then passing the verifier's actual error code to the failure RPC.
Deployment and hosted acceptance remain pending; this adds no production call.

## November 4 — durable local delivery artifacts (W03/W09, EX-01/OP-04)

Implementation: each immutable delivery snapshot creates a deduplicated local
`render_delivery` job and its required combined or technical/financial artifact
set. Executor-3 claim, local-drain and wake RPCs preserve old-worker exclusion,
fair scheduling, model-slot accounting, restore, revision and lease guards.
Snapshot/content commits reserve no storage. The first worker context atomically
reserves the whole volume set against the existing combined 250 MiB ceiling;
unknown upload bytes retain their 10 MiB reservation and stable path until a
verified receipt or confirmed purge cleanup. Burst updates coalesce only older
unattempted, unleased, entirely unreserved pending work; ready and uncertain files
remain retained.

The SQL service contract rechecks current actor/source access and immutable pins
before reads or ready commits. Individual downloads require the complete volume
set and successful package, followed by current actor/source/hash authorization.
Authenticated metadata excludes storage paths. Receipts bind actual worker
verification to artifact identity, lease, hash and size; SQL alone does not claim
to inspect DOCX bytes. Rendering never changes proposal approval, accepts model
content, calls a model or settles unknown usage.

Retry policy 1 permits at most six transient failures, including expired worker
leases, with bounded exponential delays for reported failures. Exhaustion leaves
an explicit blocked package and retained bytes. `delivery.snapshot.retry` is an
explicit current Editor/Owner action with delivery revision and idempotency checks;
it creates a new local job under the current actor, preserves ready/uncertain
bytes, and gives only restored missing volumes a fresh path. It never revives a
historical actor or paid model job. Backup manifests include ready artifact bytes;
restore retains completed packages and permits explicit completion of partial
packages. Archive, purge, storage cleanup and maintenance retention now cover the
new artifact/job references.

Local evidence: **201 focused tests across seven files** pass, covering 38 new
artifact cases plus snapshot, generation, fair queue, wake, retention and recovery
regressions. The final corrupt-pin failure-recording adjustment was rechecked in
all 38 artifact cases. Completed and partial two-volume backup/restore roundtrips
pass. Six additional real PostgreSQL 17.6 cases observe independent sessions
waiting on database locks before checking duplicate/conflicting receipts,
source/membership/cancellation changes and competing document/artifact capacity.
Both lockfile installs, both typechecks and both builds pass; the frontend retains
the existing large-chunk build warning. Independent SQL review found no remaining
blocking issue. The integration owner runs full combined suites and the actual
renderer/API/UI checks before release.

Deployment/hosted acceptance: **not deployed**; only local synthetic databases
were used. No production, model, storage service or email call was made. Queue
and delivery latency SLOs, actual storage saturation behavior, real DOCX/layout
acceptance, the isolated cloud restore drill and hosted user download acceptance
remain open. Finite retries and a local capacity guard do not establish guaranteed
wall-clock availability under infrastructure outage or exhausted storage.


## November 4 — worker maintenance isolation (F11 / part of W09)

Implementation: eligible business work is claimed and processed before unrelated
maintenance, reminder scheduling, notification delivery, abandoned-request usage
reconciliation and storage cleanup. An empty first claim runs housekeeping and
then reclaims once through the unchanged canonical queue, preserving same-tick
scheduling without a drain loop. Each housekeeping boundary reports only a fixed
operation name through `worker_maintenance_pending` and the worker response's
`maintenance_pending`; no provider, credential or customer exception text is
emitted. Failed cleanup items retain their existing failure/lease accounting and
do not abandon the rest of an already leased batch. Confirmed remote usage can
now be reconciled after business work in the same invocation; it remains GET-only,
retains the exact accepted request, and never infers missing usage as zero.

Authorization, source eligibility, model capacity, due times and exclusive job
leases remain in the canonical claim/processing paths. Their failures are not
converted into housekeeping-only success. This change adds no queue class,
schema, storage capacity, provider permission or billing policy.

Local regression evidence: six new focused cases fail against source `b1a9793`
and pass with this implementation. The new handler cases cover healthy execution,
each housekeeping fault, stalled maintenance after business commit, malformed
cleanup receipts, partial cleanup, unreconcilable usage, authentication and critical
business/source failures. Queue database cases verify real admission, exclusive
leases, future due times and occupied model capacity under housekeeping outages.
Both lockfile installs and both package typechecks/builds pass. **258 focused
tests across 11 files** pass for worker, queue, provider lifecycle, collection,
notification and operations behavior. The integration owner runs the complete
combined repository suites before release.

Deployment and hosted acceptance: **not deployed**; no production, provider or
email request was made for this change. W09 remains open for artifact queue
integration, measured delivery/queue SLOs, storage saturation and isolated restore
exercises (D01/D04/D05). In-flight housekeeping can still consume the remaining
worker invocation after business commit; this change does not claim a measured
latency bound, independent maintenance service or completed cloud restore.
## November 4 — permanent DigitalOcean access reference

The Owner requested an immediately discoverable, persistent reference for the
established GitHub Actions route to DigitalOcean. The new
[DIGITALOCEAN_ACCESS_RUNBOOK.md](DIGITALOCEAN_ACCESS_RUNBOOK.md) records the fixed
cluster/namespace, runner and validation helpers, credential/TLS boundaries,
workflow-selection procedure, historical successful runs and required new-run
evidence. Root `AGENTS.md`, the original Kubernetes guide and the operations
entry point link directly to it. This documentation is published separately on
the default branch so future checkouts can find it before runtime changes merge.

The known local Envoy certificate failure is distinguished from the verified
runner route. Existing full access checks can also perform isolated compatibility
bootstrap, and diagnostic workflows can have conditional repair steps; reading
the whole workflow remains necessary before dispatch. No unimplemented inventory
mode is presented as available.

Validation: all relative runbook links and referenced workflow/helper paths were
checked against the repository; the documented route and historical run results
were reconciled with the actual workflow definitions and GitHub metadata. This is
a documentation-only change, with no application/schema/runtime modifications,
workflow dispatch, certificate/firewall change or production mutation. Existing
application test results are not recast as a fresh deployment acceptance.

## November 4 — complete proposal-delivery remediation and acceptance plan

The Owner requested a complete, evidence-based repair and testing plan for the
engineering due-diligence findings, saved in GitHub. The
[remediation plan](RELIABLE_PROPOSAL_DELIVERY_PLAN.md) maps **F01–F11** and their
subfindings to **W00–W11**, dependencies, responsible roles, measurement gates
and closure evidence. The [acceptance specification](RELIABLE_PROPOSAL_ACCEPTANCE.md)
defines **T01–T20** and **42 detailed cases** for faults, semantics, concurrency
and artifacts, including typed verification for all 13 registered model tasks.
Stages 2–7 are affected, including shared routing and worker regression for
collection; adjacent-workflow regression remains required.

Implementation status: **documentation only**. No new application contracts,
migrations, renderer, OCR pipeline, recovery transition or acceptance tests are
implemented by this change. All remediation packages and new acceptance cases
remain open. A downloadable file, an accepted model response and a substantively
complete proposal are separate outcomes. Valid RFPs cannot satisfy completion
by receiving a blank template; operational failure cannot be labeled invalid
input. The plan includes a proven completion route during total model outage
and explicitly reconciles narrow unknown-usage recovery blockers with the
Owner's October 19 automatic-routing policy without restoring daily caps.

Local validation on source `bd409896aa356cb6a5d9f73aee7ef202152f1b69`
(tree `51a6cac929648a93369a3314a8d0efce39ee1a1b`): both lockfile installs,
typechecks and builds passed; **1,841 backend tests / 110 files** and
**269 frontend tests / 40 files** passed, totaling **2,110 existing tests**.
These establish a local baseline only, not proof of the proposed corrections.
Independent coverage and model/design reviews found no remaining material plan
omissions after correcting early-snapshot self-staleness, legacy acceptance
provenance and pre-run semantic qualification criteria. Relative document links,
case identifiers and all 35 explicitly runnable test paths were checked.
Warnings remain: deprecated `whatwg-encoding`, jsdom performance advisory and
a frontend bundle above 500 kB. The operations Python suites were not rerun for
this documentation-only change; the plan requires appropriate operations and
deployment checks when those implementations change.

Deployment and hosted acceptance: **no application deployment, production
mutation or live provider evaluation in this planning change**. GitHub
publication records the plan, not completion of any runtime remediation.
Fresh production inventory, each failing regression, implementation evidence,
isolated fault tests, compatible rollout and actual upload-to-Word acceptance
are required by the linked plan before closure. Private historical evidence
and customer material remain outside this repository.

## November 3 — integrated AI reliability verification

The Owner requests comprehensive model and prompt testing after the October 31
QwenCloud activity stop. The isolated reliability change fixes terminal remote
polling and misleading usage/identity diagnostics, and adds versioned analysis
evidence instructions. Historical prompt pins, accepted requests, usage and
business records are retained. Full GitHub verification of `5d53a96` passes
**1,617 backend tests in 95 files**, **265 frontend tests**, both packages'
typechecks/builds, **196 operations tests** and **13 Kubernetes renderer tests**
in [run 41550067592](https://github.com/salahassi/tenders/actions/runs/41550067592).
Focused independent
review checked remote-ID matching, unknown accounting, failover, immutable prompt
pins and private live-evaluation transport. A stale earlier operations run found
an ambiguous SQL identifier in the release wrapper; the corrected qualified
query passed the fresh full 189-test run.

The core live evaluation completed all 32 cases in
[run 41545612647](https://github.com/salahassi/tenders/actions/runs/41545612647),
source `bc4c2398a4a49202fa02cf4c56360ebfbf08628d`. Both QwenCloud models passed
8/8 cases each, including bilingual extraction, exact quotation, prompt
injection, missing company evidence, wrong-quote repair and unsupported-claim
grounding. OpenAI's two models could not complete any case: 14 generation
requests returned HTTP 429 `usage_limit`, and two accepted background probes
ended in an explicit failed status. These are provider availability results,
not 16 prompt-quality failures. Both background responses were deleted;
no evaluation request remains pending. Known usage is 39,326 input and 8,529
output tokens; the 16 OpenAI cases have unknown usage, not asserted zero cost.
The encrypted report was downloaded with verified digest and its temporary
transport object deleted. No application business records were created.

Expanded routing evidence confirms both Qwen models are enabled in saved
assessment routes; exclusion from those saved routes is disproved. The private
permission snapshot at 23:44 UTC establishes a separate current blocker: all
63 examined active-status assessment plans lack manual request receipts and
exact active Qwen notice grants, and Qwen is excluded from the current automatic
processing policy. Preflight therefore skips it before recording an attempt.
Automatic policy grants are lazy, but cannot authorize an excluded provider.
The policy's current approval timestamp is October 20; this snapshot does not
prove every historical policy state. No consent or content permission was changed.

The extended Qwen-only evaluation completed 16 requests in
[run 41547638324](https://github.com/salahassi/tenders/actions/runs/41547638324),
source `850e74f480a38c101c4fb713e90f67a939352df4`: 12 passed. DeepSeek passed 5/8;
structure, commercial and source-inspection requests returned HTTP 400
`invalid_parameter_error` with unknown usage. Qwen passed 7/8; its valid JSON
blueprint failed the production ownership/coverage validator with
`MODEL_COVERAGE_INCOMPLETE`. The exact rejected invariant and provider error
messages were not retained, so they are not guessed. All requests completed,
with no remote cleanup pending. Measured usage is 34,451 input and 7,754 output
tokens; three cases retain unknown usage. Its verified private transport object
was deleted after download. A targeted diagnostic rerun of only these four
model/case pairs completed in
[run 41548978379](https://github.com/salahassi/tenders/actions/runs/41548978379),
source `33c4b23b8717c01ce28a5e2ce525bd36824d7727`, using unchanged prompts and
request profiles. All three DeepSeek requests passed; their earlier 400 errors
were intermittent, and their precise cause is still unknown. Qwen's blueprint
failed again: its processed-ID checklist listed both requirements, but the
candidate contained only an executive summary and assigned neither requirement
to a narrative unit. Known usage was 7,876 input and 2,305 output tokens, with
no unknown usage or cleanup pending. The private report transport object was
deleted after verified download.

That captured failure exposed an application recovery defect: planning domain
validators rejected the candidate before acceptance but omitted typed diagnostic
details, so the graph skipped targeted repair and consumed normal writer
attempts. The new correction annotates existing validation rules without relaxing
them and maps diagnostic requirement IDs to the model-visible aliases. Durable
blueprint and structure regressions prove one writer, one repair and one
independent verifier, immutable rejected evidence/usage, and zero extra calls on
accepted replay. Phase-pinned policy revision 5 additionally requires narrative
ownership independently of processed-ID lists or missing company proof; revisions
0–4 and existing paid phase pins retain their exact inputs. Focused suites pass
85 domain/recovery tests, 98 prompt/pinning tests, and 21 evaluation tests, plus
12 Python guards and backend typecheck (suite counts overlap). The final
two-request Qwen evaluation passed **2/2** in
[run 41550112563](https://github.com/salahassi/tenders/actions/runs/41550112563),
source `5d53a96672ee41c8d52df7a6a08adf75ec51b8ca`: both a fresh revision-5
blueprint and repair of the captured invalid candidate passed canonical and
production ownership validation before success. Usage was 7,042 input and
2,229 output tokens, with no unknown usage or pending cleanup. Its private
transport object was deleted after verified download. The latest permission
snapshot still excludes Qwen from automatic processing. Across all four live
runs, 54 generation requests were made; earlier failures remain recorded and
are not rewritten as first-attempt successes. Final integrated CI passed on
the same source revision. All production preparation/build/deployment steps
were skipped because this was a push-triggered verification run.

The extended fixtures, combined with the core suite, exercise all 13 registered
model task types. Production structure, blueprint and review validators are
included alongside explicit tests for requirement ownership, unknown prices,
source fields, review durations and eight bilingual obligations among longer
mixed-role inputs. Focused offline verification passes 17 Vitest tests and
10 Python guards plus backend typecheck; all eight core prompt hashes match the
completed core live run. The extra requests select QwenCloud only in SQL,
Python and JavaScript, and remain capped at 16. The permission diagnostic is
aggregate evidence only: lazy policy grants, receipt selection and active
content eligibility still govern actual preflight authorization.

Production release has not run. Live synthetic contract checks are not a
completed real proposal, a human-labeled business-quality evaluation or proof
that all prompts work on arbitrary documents. No existing blocked work is reset
by this change. OpenAI account limits remain an external blocker.

## November 3 — analysis evidence prompt and repair regression coverage

The production diagnosis found repeated invalid source quotations and exhausted
correction attempts during proposal analysis. Existing writer instructions did
not spell out the validator's distinction between source-block IDs, extracted
requirement IDs and source roles. Semantic policy revision 4 adds an explicit
analysis evidence contract for newly started analysis, its repairs and its
verification. It requires original-language contiguous quotations, complete
source-block coverage and the correct evidence type, and gives bounded,
application-owned repair guidance for each retained validation reason. Flexible
reference inputs retain their distinction from actual buyer requirements.

Historical semantic revisions 0–3 and already pinned phases retain their exact
wire inputs. Existing quotation, company-evidence and coverage validators remain
unchanged. Local verification passed 84 tests across the bilingual analysis
prompt/validation matrix, database-backed semantic pinning and writer handoff
suites, plus the backend typecheck. These tests use synthetic local fixtures and
mocked provider transport. The separate live analysis/repair and longer mixed
evidence cases passed on both QwenCloud models, as recorded above. Deployment
and recovery of the previously blocked proposal remain pending.

## November 2 — workspace startup blocked by audit-history size

The Owner's authenticated Jobs screenshot shows "Workspace results exceeded the
supported boundary" while successful audit-history requests continue. The
frontend required every audit page before admitting the workspace, then threw
after 10,000 rows with a continuation cursor. This is an application loading
failure, not evidence that authentication failed or business data disappeared.
The earlier hosted PDF probe checked extraction and public assets; it did not
exercise authenticated workspace startup and did not establish this acceptance.

The repair removes audit history from required startup. Source decision history
loads separately in bounded pages with visible loading, continuation and retry
states, including an honest explanation when the loaded history contains no
matching source events. History is retained on the server. The existing endpoint
does not filter by source, so older matching events may need further pages.
Required jobs and business records retain complete pagination without the
arbitrary 10,000-row ceiling; malformed or non-progressing pagination still fails
explicitly. Membership, authentication and required business-read failures are
not converted into simulated success.

A dedicated Chromium regression exercises the built application's actual
Jobs and Dashboard routes using isolated synthetic authentication and API
fixtures, including more than 10,000 audit events. Every fixture request is
intercepted at a reserved test origin; it creates no production records and
accesses no real user session. The release runs this gate before production
access and retains the existing hosted PDF and exact-asset acceptance.

Implementation and independent review passed. Final local frontend typecheck,
build and all 265 tests in 39 files passed, covering complete 10,001-record job
and opportunity collections, required authorization failures, invalid cursors,
history retry, refresh and stale-response isolation. The release additionally
builds pinned prior main `b997f2fc4aa01a3d7e6446233975c69f3b9a29d7` to reproduce
the original 20-page failure before testing the candidate. This baseline check
is limited to the workspace-history release branch and preserves its build.
Actual Chromium execution and deployment passed in
[workflow 41495675488](https://github.com/salahassi/tenders/actions/runs/41495675488),
source `daf6ed1020ad4012f5f26d5e3ec1c3d24d30d6ab`, job `125449857222`.
The old build reproduced the reported boundary error after 20 audit requests
with 10,501 fixture events. The candidate opened Jobs and Overview with zero
audit requests at startup. Source history loaded on demand, retained the page
and existing records through an injected HTTP 503, and successfully retried the
same cursor. Fixture screenshots are retained in the workflow artifact
`workspace-browser-fixture` (ID `13166367424`); screenshot capture does not
constitute separate manual visual review.

Exact-source CI passed both package typechecks/builds, 265 frontend tests,
1,539 backend tests and 175 operations tests. The frontend-only deployment
passed readiness, hosted PDF extraction, all 50 public build assets and runtime
configuration checks. Other workload specs were preserved, and temporary
credentials and logs were removed. The deployed frontend digest is
`sha256:bfb0771209f3a3b3d03c075fb1e87bedf731c9f3418215960365635a8b7f0774`.

Local Chromium launch was blocked by the sandbox, and the connected
local-browser tool is unavailable in this session. The successful Chromium
regression used isolated fixtures: `production_requests=0` and
`real_auth_verified=false`. Browser fixture acceptance and public hosted
acceptance must not be described as testing the Owner's actual authenticated
workspace or a complete paid proposal-to-Word journey.

## November 1–2 — branch, release and project-plan reconciliation

A fresh remote audit found 39 branches and one open pull request, [#14](https://github.com/salahassi/tenders/pull/14).
Twenty non-main branch tips are ancestors of main. Of the eighteen divergent
branches, fourteen hold historical operational/diagnostic work, two were
squash-merged, one contains saved-work recovery already integrated in main, and
one holds the PDF extraction correction in #14. Divergence alone is not a
reason to merge an old operational branch. No branch was deleted by this audit.

Current main `e650078021c904ea2e3160df6a82a3b87309a28c` differs from the
deployed flexible-input source `492e42e5159463e5089b6ae2afcf3ca7bc8220a3`
only in this implementation checklist. The November 1 release completed at
12:11 Asia/Riyadh in [workflow 41287120748](https://github.com/salahassi/tenders/actions/runs/41287120748).
Fresh public asset checks confirm the deployed "Generate proposal draft" and
"Upload reference files" controls, and the absence of the removed individual
content-permission screen. Root HTML is served with `Cache-Control: no-store`.
Existing paid snapshots retain their frozen semantics; deployment does not
regenerate an existing plan or activate a new model request.

The audit also confirmed a current production regression. The PDF module
`/assets/pdf.worker.min-CjEcRF4W.mjs` returns HTTP 200 with
`application/octet-stream` and `nosniff`, including with the versioned query.
The current extraction worker lacks the cache-bypassing query. The October 29
frontend-only PDF correction was deployed from #14 but never merged into main;
the later frontend build therefore replaced it. A successful release record
does not establish that every earlier branch-only correction is present.

The correction is restored on the current main application tree, preserving
the requested-processing and flexible-input changes. Its six source/tool files
restore #14 with a new `javascript-v2` worker cache key, since this second
regression could also have cached an invalid response under the former `v1`
URL. That cache state is plausible rather than observed. The historical
acceptance entry below is retained. Independent review found no incompatibility
with the current renderer, ownership checks or
worker protocol. The frontend-only release uses an immutable image, checks
ownership and concurrent edits, preserves other workloads and runtime
configuration, and rolls back its own image if readiness, exact assets or real
Chromium PDF extraction fails. It neither changes the database nor submits
inference. Backend verification passed all 1,539 tests and its typecheck/build;
all 175 operations guards and 13 renderer tests passed. The final frontend
with the new cache key passed typecheck/build and all 251 tests in 38 files.
Hosted recovery passed on November 2 in
[workflow 41457072538](https://github.com/salahassi/tenders/actions/runs/41457072538),
source `f767af503ef243ed9136963c45efd441b5143b0a`, job `125316349304`.
The workflow completed at 17:00 Asia/Riyadh. Exact-source CI passed both package
typechecks/builds, 1,539 backend tests, 251 frontend tests and 175 operations
tests. The frontend became ready; real Chromium PDF extraction and exact
index/configuration plus 50 public build assets passed. Other workload specs
and public configuration were preserved, and temporary release credentials and
logs were removed. No database access or model activation was performed by the
frontend updater.

Deployed frontend digest:
`sha256:bbeb165d79724daa35fb67726ae531d4bee224f741ba06a095a22c12740c90a0`.
The release source contains all of main's flexible-input and requested-processing
changes. Authenticated upload/storage and a new paid draft-to-Word execution
remain separate acceptance.
The November 2 resumption verified that main and #14 have not
advanced since the audit; no restoration had been published during the
interrupted session.

The plan is not complete. M2 through M5 have substantial implemented and
deployed functionality: invited authentication and isolation, official-source
collection, assessments, proposal drafting/revision and Word delivery.
Historical real Word acceptance on October 22 covered 56 sections and 122
requirements, authenticated downloads, and rendered technical/financial
documents. That acceptance predates the DigitalOcean migration and the newest
input behavior. A fresh authenticated DigitalOcean upload-to-draft-to-Word and
feedback-to-regeneration acceptance, isolated backup/restore with originals,
and current final business approval remain open. Source-directory entries do
not prove every portal adapter is operational. The migration intentionally
copied the Owner/configuration and selected sources; historical opportunity
and document migration is separate. M6 still needs the human-labeled notice
evaluation, proposal editorial review and measured latency/call-reduction
evidence. Older dated checklist tables, security notes and runbook baselines
must be read with the later dated decisions and release entries.

Main pushes currently publish the legacy Pages redirect; DigitalOcean releases
use explicit release branches or manual dispatch. The application has no
visible source-version indicator. These are release-observability gaps; this
restoration does not claim to redesign the deployment policy.

## October 31 — draft from arbitrary reference inputs

The Owner requires uploaded material to permit proposal draft creation even
when it is not an RFP, is unrelated, incomplete or unreadable. The draft path
will accept saved reference originals without requiring all extractions to be
ready or confirmed. It uses only actual readable text and notice evidence,
records omitted/unchecked material and preserves explicit missing-information
questions. Empty requirement inventories must still reach planning, writing
and draft download with real source references rather than synthetic facts.

Implementation and independent review passed. New-work semantics are versioned
so existing paid work remains immutable. Draft intake and final approval are
separate: source completeness and unresolved omissions remain reviewable before
final approval, while draft creation/download continue. At least one saved
attachment remains required; its document type, readability and confirmation
are not drafting prerequisites.

Both package typechecks/builds passed locally and in exact-source release CI,
including 1,539 backend tests and 251 frontend tests. The final 12-test runtime
matrix exercises real durable graph progression and draft Word export for
non-RFP and all-unread inputs in both current legacy and hierarchical workflows,
zero inventories, real notice citations and mixed unread addenda. Twelve SQL
tests cover intake, scope, currentness, final approval and draft export. All
162 operations tests and 13 renderer tests passed after the deployment guard
correction, including 11 focused release tests against final migration
SHA-256 `5bac8ff0a8e070688873b2e6c020a3c7ddb51c7dc8e0ad8005735e4e653ccf6c`.

The release installs the backward-compatible runtime first and waits for old
processes to drain before enabling new SQL inputs and publishing the frontend.
After any schema attempt it retains the compatible runtime if frontend rollback
is needed. Deployment and hosted acceptance passed as recorded below. No live
paid generation or completed customer proposal is claimed by this entry.

The first release attempt, [41249722828](https://github.com/salahassi/tenders/actions/runs/41249722828),
on source `48a7ecd27ef80963c89193da711f38077d596d19`, passed exact-source tests
and image builds, then refused Pod ownership before attempting SQL. Its guard
incorrectly assumed the top-level Deployment management label was inherited by
Pods; the canonical renderer supplies only application labels to Pod templates.
All four runtime images rolled back successfully, frontend and SQL remained
unchanged, and temporary resources were removed. The corrected guard verifies
the exact Pod-to-ReplicaSet-to-managed-Deployment controller names and UIDs,
with namespace/container/image checks. Canonical renderer fixtures and spoofed
ownership rejection pass; runtime drain and compatible rollback remain intact.
Corrected deployment and hosted acceptance passed on November 1 in
[workflow 41287120748](https://github.com/salahassi/tenders/actions/runs/41287120748),
source `492e42e5159463e5089b6ae2afcf3ca7bc8220a3`, job `124790560824`.
Exact-source verification passed 1,539 backend tests, 251 frontend tests,
162 operations tests, 13 renderer tests and both package typechecks/builds.
All four compatible runtime workloads became ready, old processes drained,
the migration committed with existing business records and frozen paid work
preserved, and the frontend became ready. Public configuration, anonymous Auth
boundaries, provider assets and the served flexible-draft controls passed.
All five workloads and temporary-resource cleanup passed.

Deployed runtime digest:
`sha256:c5a1d4d3bc108333a34233d5488c820130ee462c1940e74b17c4dcbbb33f9cde`.
Deployed frontend digest:
`sha256:3685fa1527dbee98b1e6fc2890cae93d4880daeaf9d90837464c84a572c73360`.
The new semantics apply to newly created or regenerated drafts for every
authorized user. Existing paid snapshots remain immutable; deployment did not
restart processing or activate models. Authenticated visual browser QA and a
new live paid draft-to-Word execution remain separate acceptance.

## October 31 — remove separate permission review for requested processing

The Owner explicitly removes the hidden per-document/per-provider model
permission step for all users. The implementation binds existing authorized
workflow requests and resumes to their selected tender/review inputs, preserving
membership, workspace scope, current content hashes, actual content
restrictions and durable model/usage accounting. Automatic collection and
Company Knowledge retain their workspace policies. The obsolete individual
permission screen is removed. The opportunity explains processing failures in
context and supplies an error notification and existing recovery action.

Implementation and independent review passed. Both application typechecks and
builds passed, with 1,515 backend tests and 245 frontend tests. Twenty focused
request-authorization regressions cover direct requests, every execution mode,
Owner/Editor parity, exact hashes, isolation, content restrictions, revocation,
idempotency, saved-work recovery, historical proposal style inputs and approved
current rates. All 151 operations tests and 13 renderer tests passed. Release
guards verify the actual migration under production-equivalent restricted
database privileges, atomic checksum history, safe replay and existing-record
preservation. The independently reviewed recovery helper accepts only a
privately encrypted exact-plan selection, verifies the deployed migration and
runtime, and invokes canonical retries for its exact selected tasks while
preserving immutable inputs, attempts and model accounting. Deployment and
affected-work recovery passed the acceptance recorded below. Full proposal
completion and Word delivery remain separate acceptance; no completed proposal
or model result is claimed by local checks.

Deployment source `658ad8d6e1c80416c95acd490f5dcc63fd9360ef` passed the remote
application and operations checks in [workflow 41204308650](https://github.com/salahassi/tenders/actions/runs/41204308650).
The requested-processing migration committed with existing records and model
accounting preserved. All five workloads were ready and served-asset acceptance
verified removal of the individual permission screen and presence of in-context
processing help. The runtime digest is
`sha256:c0f61756361e6474e50e04eb8bca38754e62eee5510701fe1528d0b3c1d23be5`;
the frontend digest is
`sha256:da1c8b8c07e786250a7640a8c4295a5075f7c84c4464eb4a59817c8a4325e1fe`.
The separate exact-plan recovery step refused its canonical command and rolled
back; the overall workflow therefore reports failure even though deployment
and public acceptance passed. Its private receipt requires further diagnosis.
No affected-work resumption or completed proposal is claimed at this checkpoint.

Private rollback diagnosis in workflows `41207421875` and `41208925063` found
one canonical active Owner membership but zero matching Auth rows visible to
the operational role, despite Auth-table SELECT permission. The helper now
delegates through the existing active Owner membership/allowlist and canonical
member_role authority; direct Auth visibility is diagnostic only. No Auth
grants, RLS, credentials or account state changed. Expanded operational
regressions verify canonical delegation with inaccessible Auth rows, rejection
of inactive or non-Owner authority and complete diagnostic rollback.
The resume-only workflow uses the already verified runtime and migration;
live affected-work recovery remains pending. Application PR [#15](https://github.com/salahassi/tenders/pull/15)
merged as `79b0e0efe9d6d95fac721ab31787d0bba08b9670`.

The subsequent canonical whole-plan retry reached its legacy workspace usage
guard and refused `USAGE_REVIEW_REQUIRED` for unrelated prior model usage. The
selected proposal still has no sent attempts or usage. Its recovery now uses
the existing canonical per-job retry for exactly its blocked current-stage
tasks in one transaction, retaining that command's same-job usage checks and
normal provider reservation controls. Expanded fixtures cover all twelve
selected tasks, unrelated unknown usage remaining identical, same-target usage
rejection, exact idempotency receipts and rollback of accounting mutations.

Live recovery passed in [workflow 41220950555](https://github.com/salahassi/tenders/actions/runs/41220950555),
source `51947c37790802b208263db33defa40139df83af`, job `124595191356`.
Its receipt confirms one proposal resumed through the selected canonical task
retries, with immutable inputs, counters, graph state and whole-workspace usage
preserved. All recovery resources and runner plaintext were cleaned. The
application remains on the previously verified immutable runtime/frontend;
recovery did not redeploy or change accounts, RLS, providers or usage records.
The separate permission step is removed for all authorized users, served UI
acceptance passed, and the affected proposal has returned to processing.
Originals and prior work remain intact. Proposal completion is not claimed.

The maintenance workflows now require explicit private selection inputs and
default to diagnosis when invoked manually; the one-shot push trigger and
embedded transport selection are removed. Temporary transport uses generated
encrypted objects, authenticated private readback and subsequent removal;
the transfer helper revokes temporary bucket keys after every operation.

## October 29 — PDF extraction worker MIME correction

The reported RFP upload fails before PDF text extraction because the production
PDF.js worker asset is served as `application/octet-stream`. A read-only GET of
`/assets/pdf.worker.min-CjEcRF4W.mjs` returned HTTP 200 with that content type and
`X-Content-Type-Options: nosniff`; its body is the actual PDF.js module. The
browser therefore rejects the module and the library's fallback import fails.
The served worker is byte-for-byte identical to the locked production build
output, confirming that the module content itself is not missing or mismatched.

The frontend Nginx asset location now includes the standard MIME map and adds
`application/javascript` for `.mjs`, preserving ordinary JavaScript, CSS and other
asset types, caching, and missing-asset 404 behavior. The worker URL also carries
a stable `module-mime=javascript-v1` cache key. A same-origin, same-context
Chromium regression first caches the old octet-stream response, reproduces the
failure after a server-only MIME repair, then extracts the expected PDF text
and matching SHA-256 with the new URL without clearing the browser cache. A
second extraction reuses the correctly cached module. The separate console JSON
parse error has no reproduced source in the current Jobs path and is not claimed
fixed by this correction.

Local production acceptance passes against the image built from the pinned
frontend Dockerfile. Nginx validates the corrected configuration. Two restricted,
read-only local containers reproduce the exact module-import failure with the
previous configuration and successfully extract the expected text from a
synthetic PDF with the correction. Chromium verifies the real built extraction
worker, the PDF.js module request, a ready document and its exact-byte SHA-256.
HTTP checks also preserve JavaScript/CSS media types, immutable caching,
`nosniff`, and missing-asset 404 responses. Both temporary containers were removed.

Both packages were installed from their lockfiles and pass typecheck and build.
The frontend passes all 241 tests in 39 files; the backend passes all 1,495 tests
in 87 files. Verification uses one test worker per package without changing
test assertions or timeouts. The final source diff passes `git diff --check`.

The Owner's follow-up confirms that the local correction did not resolve the
live website. The release now includes a frontend-only workflow: publish one
immutable frontend image, compare live ownership/configuration/image identity,
replace only that deployment's image, wait for readiness and verify the exact
public build, media types and real Chromium extraction. Failed acceptance
triggers a guarded return to the original image. The updater reads no database
or Kubernetes Secret and performs no restoration, provider activation or other
service update.

Refreshed release verification passes the frontend typecheck/build and all 241
tests, all 156 operations tests (including 13 frontend update guards), workflow
YAML/shell syntax, and the permanent browser probe against real local Nginx.

Deployment and hosted extraction acceptance passed in
[workflow 40901422543](https://github.com/salahassi/tenders/actions/runs/40901422543),
source `83432b210dce046ed898b3c2463580be91cc8e2d`, on October 29. The published
frontend digest is
`sha256:36a6afd3c43f8d3364cf7a3341fa7772e8dee2bbf546c30baf5a6c4afb2cf03f`.
Fresh CI passes both package typechecks/builds, all 241 frontend and 1,495
backend tests, and all 156 operations guards. The rollout verified 50 public
build assets, the preserved runtime configuration and other workload specs,
then completed real PDF extraction in Chromium. Runner credential/log cleanup
also passed.

A separate browser probe from the working environment confirms the live new
extraction worker and `.mjs?module-mime=javascript-v1` return HTTP 200 with
`application/javascript`; the expected PDF text, ready status and SHA-256 all
match. No application record is created by either browser probe.

Status: the correction is deployed and hosted static/extraction acceptance is
complete. The same-context cached-response regression also passes locally.
Authenticated upload/storage acceptance of the Owner's actual RFP is separate
from these synthetic, browser-local extraction probes.

## October 29 — approved model execution and Needs attention recovery

The Owner explicitly approves enabling the saved model route, sending a real sample assessment within existing data permissions, and recovering the remaining assessments after success. The Owner additionally requests reviewing and restarting items under Needs attention after that sample succeeds. [Execution 40865017755](https://github.com/salahassi/tenders/actions/runs/40865017755) enabled the saved route and created exactly one fresh assessment at 11:23:40 UTC, with 17 other current missing-configuration plans remaining. Existing attempts and usage history remain intact. Sample completion verification is running before batch recovery.

Needs attention in the Jobs screen means blocked or failed jobs. A separately gated helper inspects their actual errors and only retries current, never-sent technical failures through canonical per-job commands after the completed sample has a persisted fit assessment. It retains usage/accepted requests, human verification, consent, stale evidence and correction-exhausted cases for their applicable resolution. Two PostgreSQL orchestration guard tests pass; completed business assessments requiring human judgment are not treated as technical job failures. Live review and counts are pending execution.

The first marked sample fetched refreshed detail evidence and was canceled canonically with `NOTICE_DETAILS_REFRESHED`; a successor assessment then blocked with `GENERATION_HANDLER_FAILED` before any provider send or usage. The recovery gate now follows only the anchored latest assessment successor for that exact refresh case, preserving the original audit and frozen history. It has a guarded one-time canonical retry for the current never-sent technical failure after remediation; no other assessment is released before acceptance.

Sanitized worker stack locations from [diagnostic 40866047562](https://github.com/salahassi/tenders/actions/runs/40866047562) identify LangSmith profile discovery (`fs_exists` → `profiles` → `Client` → `RunTree`). The pinned client reads the home profile even with tracing disabled; the container correctly denies that read. The supported `LANGSMITH_CONFIG_FILE` override is now explicitly set to a nonexistent path in the already-readable application tree. Docker defaults and Kubernetes rendering preserve the override for future deployments without granting home or broader filesystem access. A restricted-Deno smoke fixture checks that home reads remain denied and disabled tracing executes locally with zero outbound calls. Live runtime patch and fresh sample outcome are pending verification.

The runtime correction passed in [execution 40867167080](https://github.com/salahassi/tenders/actions/runs/40867167080), source `c518164062b7b010b28611ec1a6a540148b293fc`. Its guarded patch changed only the supported profile-path environment selector on API and worker, preserved their immutable images and other settings, and passed the actual in-container restricted-Deno smoke: local traced wrapper completed, home reads remained denied, zero outbound trace calls. Runtime verification completed at 11:41:03 UTC. The run passed 132 operations guards and 13 renderer tests; local full operations passed 133, plus all 1,473 backend and 241 frontend tests with both builds/typechecks. The current sample was canonically retried after that verification and is being observed before releasing any other work.

## October 29 — dynamic provider credential synchronization and assessment recovery

The Owner explicitly requests implementing automatic provider setup for all supported providers and requires dynamic discovery. The dedicated credentials workflow discovers canonical provider prefixes and saved connection credential aliases, reads matching GitHub Secrets in memory, and updates only supplied provider-key fields in the owned DigitalOcean runtime Secret. Missing repository values preserve existing runtime keys. Values travel through standard input, never logs, command arguments, repository files or workflow artifacts. Workload ownership and concurrent-edit guards precede changes; only API/worker processes needing refreshed values roll, retaining their images and other settings.

The workflow will run on relevant source changes, manual dispatch and every 15 minutes after publication on the default branch. New connection aliases and rotated keys are therefore discovered without editing a provider list. Routine synchronization preserves Owner enablement, routes, model profiles, data permissions, limits and schedules. An explicitly selected manual recovery action can enable the saved task route, create one fresh assessment through canonical Owner commands, and gate remaining recovery on a verified completed assessment. Existing frozen attempts remain in history. Implementation and independent review passed 14 focused tests; the full local operations suite passed 121 tests. Deployment evidence will be recorded after verification.

GitHub independently flagged the initial whole-Secret-map expression for workflow review, so no job in run 40861525208 executed. The revised workflow passes only discovered alias names between jobs and uses GitHub's dynamic `secrets[matrix.alias]` lookup to bind one approved provider key per matrix job. Missing values skip before cluster access; updates are serialized, and the final reload verifies all bindings and refreshes consumers once. The whole repository secret map is never materialized. This retains dynamic custom-alias support with narrower credential exposure.

Automatic approval review rejected advancing the initial branch because its push workflow combined credential synchronization with production model activation and potential assessment-data egress, considering destination approval insufficiently explicit. That branch advance did not execute. The workflow now performs credential synchronization only on pushes and schedules; model activation/recovery requires an explicit manual action. The Owner has been asked to approve that separate inference action while unaffected credential synchronization proceeds.

Credential synchronization is deployed and verified. [Workflow 40862195071](https://github.com/salahassi/tenders/actions/runs/40862195071) on source `36cb46154f6734842944b9279533ddfe20b971bf` passed both application typechecks/builds, all **1,473 backend tests**, **241 frontend tests** and **125 operations tests**. Dynamic discovery found ten supported aliases. The three available repository keys (OpenAI, QwenCloud and legacy Qwen) were individually synchronized; seven absent values were skipped. Final in-container equality verification succeeded for both API and worker after their refresh at 11:10:38 UTC on October 29. Model admission, routes and permissions were unchanged; the inference recovery job was skipped. Temporary database administrator resources were removed.

PR [#10](https://github.com/salahassi/tenders/pull/10) merged as `add4bf2fddb484bb266ac3f5ea7a2f5a750ce0cd`. The final version includes the partial-setup cleanup guard and documentation, with **18 focused synchronization tests**, **two recovery orchestration tests** and **127 local operations tests** passing. GitHub reports the workflow active on the default branch (workflow ID 400500526), so its scheduled synchronization is installed. A scheduled execution itself has not yet been observed; GitHub schedules are best effort. A missing key cannot be synthesized, and removal from GitHub does not revoke an existing runtime value. Actual assessment/inference activation remains pending the Owner's response to the explicit approval question required by automatic approval review.

## October 29 — blocked model assessment diagnosis

The Owner reports failing model assessments that enter blocked state. Read-only [workflow 40771182817](https://github.com/salahassi/tenders/actions/runs/40771182817), source `67875df5f4fdb6bccea607a48005f7900b9ce8ea`, inspected actual job/plan errors, structured provider telemetry, route/model enablement and runtime credential presence. The inspection printed no keys, prompts, responses or business documents and submitted no inference. Temporary administrative resources were removed.

At 21:21 UTC October 28 (00:21 Riyadh October 29), all 12 current assessment plans and their jobs were blocked with `MODEL_NOT_CONFIGURED`. The 24 stored provider attempts (Gemini and Groq, 12 each) were skipped with `sent=false`, no HTTP status and no provider usage. The Kubernetes runtime Secret contains no `APP_MODEL_*_KEY` bindings. Task execution routing and legacy automatic routing are both disabled; the new connection/model definitions exist, but the actual jobs remain on the legacy provider path. Configured OpenAI/QwenCloud catalog entries alone cannot provision keys or enable task execution.

Twelve earlier plans/jobs were canceled with `NOTICE_DETAILS_REFRESHED` as detail evidence was updated; these are separate from the current missing-configuration blocks. Source browser requests are ready and the scheduler heartbeat is current. There is no evidence here of a provider rejection, quota failure or bad model response because no model request was sent.

The follow-up [workflow 40771640131](https://github.com/salahassi/tenders/actions/runs/40771640131), source `bdfcb9794ba84af234028c1a236b3c9ed4fc26d8`, checked repository bindings as booleans only. `APP_MODEL_OPENAI_KEY` and `APP_MODEL_QWENCLOUD_KEY` are present in repository Secrets and match the enabled catalog connections; `APP_MODEL_QWEN_KEY` is also present but belongs to the separate legacy Alibaba provider. Gemini/Groq repository keys are absent. None of these keys has been applied to the live runtime Secret. Runtime keys and disabled task execution are separate blockers: the current attempts use legacy Gemini/Groq, while the enabled OpenAI/QwenCloud catalog does not select itself for execution.

Diagnosis is complete. The concrete remediation is to merge the existing OpenAI/QwenCloud credential bindings securely into `tenderdesk-runtime` without changing other secrets, reload the affected workloads, enable the intended task route through the Owner control, and recover the latest blocked assessments with their existing authorization checks. This diagnostic request did not change credentials, enable inference, alter content permissions, retry assessments or submit provider requests. The existing full deployment/bootstrap workflow must not be used merely to provision these keys because it includes restoration of the first-Owner seed; a populated application requires a credentials-only update.

## October 28 — source activation pull diagnosis

The Owner reports enabling one transferred source without a successful pull. Read-only [diagnostic workflow 40708792061](https://github.com/salahassi/tenders/actions/runs/40708792061), source `4e609ffc4f83e74106787b6b3df42226f7dd2f8f`, confirmed that Etimad was approved and the scheduler/worker were healthy. Its single actual source job attempted collection and blocked with `MANUAL_SOURCE_REQUIRED`, no collected opportunities and no pending next pull. Temporary administrative resources were removed.

The migration incorrectly set `adapter_config.automatic=false` while pausing sources. That field selects the browser-capable reading pipeline, rather than source approval. The original Etimad profile combines a reviewed extraction adapter with automatic reading; after Owner activation, the existing command retains that flag for official listings. The altered flag routed collection through the direct HTTP collector, which stops on restricted responses instead of queuing the existing browser worker. The access error can represent HTTP 401/403 or detected login/CAPTCHA; its exact response is not retained by that collector.

The correction preserves reader configuration when transferring paused sources. A guarded recovery restores only the original `automatic` field for the 36 migrated profiles, preserves all current approval states and other profile settings, and retries only the Owner-enabled Etimad job with the observed failure. Other sources remain disabled. Fixtures exercise source-state preservation, profile restoration, selected-job recovery, idempotency and refusal to overwrite edited profiles. All 107 operations tests pass, along with both package typechecks/builds, 1,473 backend tests and 241 frontend tests.

The recovery passed in [workflow 40709826660](https://github.com/salahassi/tenders/actions/runs/40709826660) on source `83b7ebb06749e45b1149f86c576b9b1e98abf511`. Its transaction restored 36 reader profiles, requeued one selected job and verified unchanged approval states. Temporary administrative resources and the encrypted snapshot were removed. Independent [readback 40710039817](https://github.com/salahassi/tenders/actions/runs/40710039817) confirmed Etimad remained approved with its original automatic browser-capable profile, and the recovered job correctly queued `SOURCE_BROWSER_PENDING`. Native browser/OCR schedules remain enabled every five minutes.

Hosted acceptance is complete for source-listing collection. The regular 14:55 UTC browser cycle rendered Etimad without a human challenge; collection succeeded at **14:55:45 UTC (17:55:45 Riyadh)** with HTTP 200 and **six real opportunities**. Source health is healthy and the operating error is cleared. Independent [final readback 40711098406](https://github.com/salahassi/tenders/actions/runs/40711098406), captured at 14:57:50 UTC, confirms the succeeded collection job, six persisted opportunities and the next six-hour collection at 20:55:45 UTC. Six subsequent notice-detail jobs are waiting on their own browser requests; completed detail retrieval or model assessment is not claimed. Other sources remain unactivated, and source approval, model settings, schedules and runtime images were preserved. All diagnostic administrative resources were removed after each observation.

## October 28 — transfer Supabase sources to DigitalOcean with collection disabled

The Owner explicitly requests moving the source directory from the retained TenderDesk Supabase project to the current DigitalOcean managed database, and requires every transferred source to remain disabled. The Owner authorized the existing private DigitalOcean Spaces bucket as an encrypted temporary transport, with deletion after destination verification. The refreshed snapshot contains 36 source records only; no memberships, Auth accounts, original files or historical opportunities enter the transfer payload or public repository.

The source transfer runs through the established GitHub Actions cluster-access path because direct Kubernetes access fails certificate verification in the cloud environment. The operation verifies the selected cluster, database CA, restoration identity, single workspace and active Owner before a serializable transaction. New rows retain source definitions and attribution while receiving paused approval (rejected sources remain rejected), no next collection date and automatic reading disabled. Existing matching records retain their destination definitions and are disabled; ambiguous matches abort the transaction. Unrelated records and application configuration remain unchanged. No runtime image, schedule, model credential or access policy is changed.

The protected snapshot was uploaded with authenticated encryption and exact ciphertext readback using temporary bucket-scoped credentials that are revoked after use. Local PostgreSQL regression verifies disabled insertion, destination-edit preservation, unrelated-row isolation, idempotent replay, safe quoting and atomic rollback of a late conflict. Both local and runner verification passed all **1,473 backend tests**, **241 frontend tests**, both package typechecks/builds, and **106 operations tests**.

Live execution passed in [workflow 40654699482](https://github.com/salahassi/tenders/actions/runs/40654699482), job `122702800227`, on source `ece89073a70295d6fd6a89fe5a9b8479239cf25c`. The database transaction inserted **36 sources**, matched zero existing rows, and a second post-commit check verified **all 36 disabled**. The resulting states are 21 paused and 15 still rejected, with no next collection dates and automatic reading disabled. No source collection was started. The temporary SQL client and administrator Secret were confirmed removed by 08:13:37 UTC on October 28; the encrypted transfer object was deleted and its absence verified by 08:13:46 UTC. Private runner payload and short-lived Kubernetes credentials were removed. No private source data or credential was published as an artifact or repository file.

Status: source transfer and destination disablement are complete. This operation does not constitute a complete database backup and did not close the Supabase account. Application runtime, models, schedules and access policies were not changed.

## October 26 — requested publication of OpenRouter and QwenCloud

The Owner explicitly requests publishing both provider additions. The migration-era deploy/promote workflows require empty business history and pause schedules during restoration, so this release uses a separate ordinary-update path. The new `update-providers.yml` workflow verifies both locked packages and deployment guards, builds only immutable runtime/frontend images, and applies the guarded provider migration before changing existing application image fields. It does not restore the first-Owner seed, alter runtime secrets, activate models, invoke collection or change native schedules.

The update helper verifies owned/ready workloads and the current restoration ledger, checks business row counts and saved source/model/execution/workspace configuration across the additive SQL transaction, preserves existing workload specifications except image references, checks public runtime configuration and the provider assets, and restores prior images if acceptance fails. Temporary administrative SQL resources are cleaned independently. The original provider migration remains backward-compatible with the previous client/worker pool sizes.

Release-path verification passed: **103 operations tests**, **12 Kubernetes renderer tests**, and a populated PostgreSQL replay of the guarded migration preserving an existing source. Existing application evidence remains **1,473 backend tests** and **241 frontend tests** with both builds/typechecks.

First remote attempt `40395807941` on `b3c0a1b238af865026850f20c76da5772e1c382b` passed all 1,473 backend / 241 frontend tests, 103 ops / 12 renderer guards and both builds, then published runtime digest `a0002bdb1f0050030f78e582c34f11baf2952ba52c7777b76d74033c8b55483a` and frontend digest `1929b3865e887443c38b695b92a4e731c22c93414bb10c45e7f8bee4b9496da2`. The update stopped at SQLSTATE 42501 on snapshot temporary-table creation: production correctly withholds TEMP from the application owner. No provider SQL committed and no image fields changed; temporary administrator resources were confirmed removed. The correction retains snapshot state inside a single anonymous block and requires no new privilege grants. The new restricted-role PostgreSQL regression passes with TEMP revoked and a nonsuperuser, non-database-owner role; it proves the populated 8→10 update and rollback of source/routing mutations. The operations suite now passes **104 tests**.

Final publication passed in [workflow 40397922106](https://github.com/salahassi/tenders/actions/runs/40397922106), job `121835797839`, on source `e9199dca8fed62c529f51f543ea2c257370db19a`. The run passed all **1,473 backend tests**, **241 frontend tests**, both typechecks/builds, **104 operations tests** and **12 renderer tests**. The restricted-role correction committed the additive provider migration with the data/configuration preservation guard satisfied at 20:48:05 UTC. API, worker, source-browser, scheduler and frontend reached verified readiness at 20:48:19 UTC. Their exact published images are runtime `sha256:5ac1fe3463c47b1fe3d8f8924e0f7625dd5eaea357ac4f078f3c84a5b4878d17` and frontend `sha256:bc9af5fb30281d374a159a668a1e4e68ca88da9117cabecb0ca47b8099ef6e76`. Runtime Secrets, workload configuration and native schedules were preserved. Temporary SQL administrator Pod/Secret and runner credentials were removed by 20:48:53 UTC.

An independent public read confirmed the new `index-CHNYwaYX.js`, `Settings-R-oDJIMM.js` and `modelProviders-DxPkj2ld.js`, both OpenRouter/QwenCloud labels, HTTP 200 application health and HTTP 401 anonymous bootstrap. PR [#9](https://github.com/salahassi/tenders/pull/9) merged as `db13b65af25ec06beb069d098e351baabd800062`; its application tree is identical to the deployed source. Production URL remains https://tenderdesk.129.212.166.115.sslip.io.

Status: code, provider migration, application publication and public acceptance complete. Authenticated hosted browser interaction and successful live model inference are not claimed. No model was activated and no source was seeded. The separate Etimad source insertion remains pending its explicit administrative-access approval.

## October 26 — requested Etimad source insertion, administrative access pending

The Owner requests adding Saudi Arabia's Etimad source to the live database. The existing reviewed catalog already supplies `sa-etimad`, named `اعتماد — المنافسات الحكومية`, at `https://tenders.etimad.sa/Tender/AllTendersForVisitor?PageNumber=1`. Official Etimad/ministry pages confirm the platform; today's direct listing read reached a JavaScript/human-verification page, so the extraction profile's October 22 validation date is preserved rather than treating today's content as collection acceptance.

A reviewed preparation script filters the catalog to this key only and calls the existing administrative source seeder after verified workspace/active-Owner identifiers are supplied. Its insert is atomic, audited and idempotent; matching source rows, states and settings are preserved. New rows remain manual/proposed with unknown health and no approved collection hosts. No source job, opportunity, model request or collection activation is included. A temporary local PostgreSQL regression passed: exactly one Etimad source, one insertion audit, identical row after replay, zero jobs and zero opportunities. Runtime application code is unchanged by this preparation.

Live insertion is blocked. Automatic approval review rejected the proposed temporary DigitalOcean Kubernetes credential retrieval, checksum-verified client setup and read-only pod inventory, stating that cluster credential access exceeds the source-add request without explicit authorization. No cluster request, database query or database write from that rejected command ran. No retired Supabase project was used as an alternative. The prepared source metadata and verification log remain in task scratch files. Explicit approval for the temporary administrative access is required before verifying the live workspace and applying the single-source insert. Live existence, insertion and readback are not claimed.

## October 26 — QwenCloud Singapore compatibility

The Owner's QwenCloud API-key link selects Singapore (`ap-southeast-1`). Official QwenCloud region and API-key documentation confirms that this platform uses `https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1`, with no workspace identifier in the hostname. The existing `qwen_free` connection uses Alibaba Model Studio's workspace-prefixed `maas.aliyuncs.com` endpoint; these are distinct connection identities.

Implementation adds the separate `qwencloud` provider, `APP_MODEL_QWENCLOUD_KEY` credential alias and model/account configuration. Its endpoint is fixed to Singapore pay-as-you-go access. The account label defaults to `ap-southeast-1` and does not select another region or modify the endpoint. The existing Alibaba endpoint and key remain separate. Structured requests use the Qwen thinking toggle, defaulting to disabled thinking with locally validated JSON. Task routes, activity filters and content permissions include QwenCloud; neither a configured key nor routing selection copies permission from Alibaba.

The still-unpublished migration `20261026112011_openrouter_provider.sql` now adds both OpenRouter and QwenCloud after the original eight providers, producing a ten-provider pool while preserving existing order/cursor. It normalizes complete older client orders, extends bounded round state, imports the separate credential alias and permits the Qwen thinking control for both Qwen platforms. This revises the local-only OpenRouter migration before any hosted application; there is no deployed nine-provider migration to replace. The existing DigitalOcean release path applies the combined guarded, repeatable migration before worker acceptance.

Local verification: backend **1,473 tests in 86 files**, frontend **241 tests in 39 files**, and both package typechecks/builds passed. Tests cover the distinct Singapore endpoint and credentials, unchanged Alibaba workspace endpoint, missing-key isolation, Qwen thinking defaults, targeted worker execution, older nine-provider clients, permission separation and repeated migration application. API contracts were regenerated; `git diff --check` passed. These are local fixture tests with mocked provider transport.

The deployment sequencer now validates ownership of the full release first, starts only Auth/REST/Storage before restoration, and defers updated application and native workloads until provider migration, compatibility checks and runtime SQL configuration all succeed. **31 deployment guard tests** passed, including successful ordering and refusal to release application workloads after any restoration/SQL failure or foreign resource ownership. No cluster deployment was performed.

Status: implementation and deployment complete, as verified in the publication entry above. QwenCloud credentials and actual authenticated inference remain separate acceptance requirements. No console account was accessed, no key was read, and no external inference was called. Token Plan uses a separate endpoint/key and is outside this Singapore pay-as-you-go change.

Sources checked October 26, 2026: [QwenCloud regions and endpoints](https://docs.qwencloud.com/developer-guides/getting-started/regions), [API keys](https://docs.qwencloud.com/api-reference/preparation/api-key).

## October 26 — current release review and OpenRouter support

Current source is `a693f33` before this change. The recorded DigitalOcean release and background activation passed in workflow `40244862158`; the application is at https://tenderdesk.129.212.166.115.sslip.io. A fresh public runtime-configuration request confirms that the frontend points to this origin. This public read does not repeat authenticated acceptance. The latest recorded operating gaps remain zero configured model keys, missing SMTP, paused models and deferred source-project deletion.

OpenRouter implementation adds a server credential slot, the fixed OpenRouter chat endpoint, owner-selected model IDs, conservative model capabilities, automatic and task-specific routing, permission choices, activity filters and display labels. Requests require upstream support for the supplied parameters. OpenRouter receives only content allowed by existing authorization rules; enabling a connection does not authorize documents or company evidence. Missing usage remains unknown. No external inference has been activated or called.

Migration `20261026112011_openrouter_provider.sql`, extended by the QwenCloud change above before deployment, appends OpenRouter and QwenCloud after the existing eight providers, preserves saved relative order and cursor, extends provider constraints and bounded round state, and normalizes older complete client orders. Guarded function edits preserve authorization and grants. It can be reapplied after the retained deployment seed is restored; the DigitalOcean deployer applies it as the application owner before compatibility acceptance. Deployment workflows accept `APP_MODEL_OPENROUTER_KEY` as a secret and optional model/account variables. Existing secret merge behavior remains in force.

OpenRouter-only verification before the QwenCloud extension above: both packages installed from their lockfiles and passed typecheck/build. The backend passed **1,466 tests in 85 files**, including the OpenRouter worker probe with a `:free` model ID, guarded migration replay, routing/client compatibility, permission separation and reasoning transport. The frontend passed **237 tests in 39 files**; the deployer passed **28 guard tests**. API contracts were regenerated and `git diff --check` passed. Official OpenRouter API, provider-routing and reasoning documentation were checked. These use synthetic fixtures and mocked provider transport; no live model request or authenticated hosted browser acceptance is claimed.

Status: implementation, production migration and runtime/frontend publication complete, as verified above. Authenticated OpenRouter inference acceptance remains pending. The live provider requires a privately configured key, a chosen model, owner routing activation and the applicable data-sharing permissions. No deployed OpenRouter success is claimed.

## DigitalOcean application deployment with only the first Owner and configuration

The Owner now explicitly requests merging the project, deploying all application
services onto the existing Kubernetes cluster, pointing the frontend at the new
server, and deleting the source project only after verifying the complete new
application. The immediately preceding data constraint remains: keep only the
first login account and operating configuration, without historical business
records or original files. PR #7 was merged into main as
`b3e8c5e377104ef20797d35f4d895d6c1e7567e6`.

Preparation generates executable application DDL from the captured catalog,
mapping hosted roles to seven database-specific `tdp_app_*` roles. Auth and
Storage run pinned upstream migrations first. The generated application contains
81 tables, ten invoker-security views, 229 routines and 66 policies. Two hosted
network/Vault dispatcher routines are replaced by a transactional durable outbox
and an authenticated persistent relay that retains immediate wake receipts,
periodic recovery, leases and bounded retries. The original queue wake guards
remain. Neither runtime nor request roles receive superuser or BYPASSRLS.

The private minimal seed contains 37 rows: one confirmed email/password Owner,
one email identity, the workspace and Owner authorization, operating/model
configuration, a fresh operations row and the private bucket definition. A
historical actor UUID preserves configuration attribution without a second login
or membership. Password hashes are retained; old sessions/tokens are cleared.
Business records, queued work and original objects are excluded. A fresh MCP
read verified the same first user, email and password hash, with active confirmed
status. Models and background execution remain paused during restoration.

A private DigitalOcean Space now transports the small seed and schema with
AES-256-GCM authenticated encryption. Upload and runner download independently
obtain temporary bucket-scoped keys and derive the encryption key from the
existing managed database credential, so no seed, password, presigned URL or
private artifact enters the public repository. A separate live transport test
passed exact-byte verification, rejected anonymous access with HTTP 403,
deleted its fixture and confirmed no temporary Spaces keys remain. The actual
minimal bundle has been uploaded privately. A Basic container registry in sfo3
was created and integrated with the selected cluster; runtime images use
immutable digests and durable read-only pull credentials.

Deployment assets cover Auth, PostgREST, persistent private Storage, API, worker,
source-browser, durable scheduler, browser/OCR jobs, frontend, gateway and HTTPS.
The new frontend loads an explicit public runtime configuration before its
bundle, without an old-source URL/key fallback. HTTPS and object bytes use
persistent disks. Worker interfaces remain internal. Native jobs and the
scheduler stay paused until the operating configuration is verified. An
invitation-aware Auth database hook preserves the real application's custom
Owner invitation flow; email confirmation stays required. SMTP and provider
credential values cannot be exported through the connected Supabase MCP; any
existing GitHub runtime secrets are provisioned without logging their values.

Local evidence: the generated DDL and private seed pass a complete PostgreSQL
18.6 rehearsal under non-superuser roles, including actual application commands,
membership RLS, outsider/direct-write denials and safe nonempty-target refusal.
Nine seed guards and twelve transport guards pass. The frontend passes 236 tests
in 39 files, typecheck/build, a real immutable Docker build, and restricted
container/Chromium transport checks. Intercepted Auth in that browser check is
not live sign-in evidence. The runtime Docker image builds; restricted Deno
health/readiness, anonymous worker denial and signal draining pass. Renderer,
permanent-role, scheduler and invitation-hook regressions also pass. Full backend verification passes 1,435 tests in 83 files, typecheck and build.
The generated schema/seed also pass the deployer's actual transactional checkpoint
wrapper in PostgreSQL 18.6, including seed rollback/resume and private ledger read
denials. Fifty-six ops guards and eleven renderer guards pass. Live deployment
and application acceptance are recorded below as execution proceeds. No production
cutover or source deletion is yet claimed.

The next runtime revision also exposes signed document URLs through an explicit
public API origin while keeping private service-to-service traffic internal.
Twenty-two real Backend.download regressions pass, including escaped signatures,
foreign-host refusal and malformed-origin handling. Full frozen-source backend
verification passes 1,457 tests in 84 files, typecheck/build and all three Deno
entry checks. API gateway bodies allow the existing large recovery envelope while
Storage retains its bounded original-upload limit.

Post-smoke activation now requires a private, workflow-bound successful acceptance
receipt. It checks an empty target and paused model admission, then verifies both
manual and actual scheduler-driven worker heartbeats, private native-worker
identities and nonce-owned empty browser/OCR executions before enabling their
five-minute schedules. Failures pause scheduling and independently clean owned
fixtures. Seventeen activation guards pass; the total ops guard suite now has 85
passing tests. These are local guard results, not live activation evidence.
The old Pages bookmark will redirect to the verified Kubernetes frontend after
merge. Old hosted API deployment and Actions-based readers are retired in that
same cutover revision; source database scheduling and source deletion remain
separate conditional actions.

First permanent live run on `51ca9ed90ba04e3fa5696b9e5a9cf6012c700b3a`,
[40238838626](https://github.com/salahassi/tenders/actions/runs/40238838626),
published all four immutable images, initialized the marked database, completed
upstream Auth/Storage migrations and restored the application schema plus the
37-row first-Owner/configuration seed. Auth, REST, Storage, API, worker,
source-browser, scheduler, frontend and gateway reached readiness. The HTTPS
container entered CrashLoopBackOff; the rollout stopped before public acceptance,
traffic cutover or source deletion. Administrator Pod/Secret cleanup succeeded.
A separate read-only workflow captures HTTPS-only diagnostics through the same
private encrypted transfer, without exposing service logs or credentials in the
public workflow output. The existing public load balancer address is reserved;
the old published application remains unchanged pending repair and acceptance.

Private HTTPS diagnostics identified the exact startup failure: the official
Caddy binary carries `cap_net_bind_service`, and Linux refuses execution with the
restricted Pod's empty capability bounding set. The dedicated HTTPS image removes
that file capability at build time and runs as UID/GID 1000, without adding any
capability. A real read-only container with dropped capabilities and no privilege
escalation passed executable, HTTP redirect, health and full certificate-verified
local HTTPS/proxy checks. The renderer now requires this immutable HTTPS image;
all twelve renderer guards pass. The diagnostic workflow can repair only the
owned HTTPS deployment and run public acceptance before a complete rollout.

The restricted HTTPS repair succeeded on `879bde4f627f8350783fdde90d87870e3a9936a7`
in [run 40241123580](https://github.com/salahassi/tenders/actions/runs/40241123580).
The container has zero restarts. All nine public acceptance groups passed with
real Auth, PostgreSQL, Storage and application APIs: HTTPS/runtime configuration,
anonymous/private-worker/admin denials, a genuine temporary first-Owner session,
invitation-hook refusal before account creation/email, Owner bootstrap and every
frontend list, empty business history with readable configuration, private byte
and public/anonymous denials, exact bytes retained across a Storage rollout, and
independent fixture/session cleanup. No fixture record was added to the Owner
workspace. Provider key count is zero and SMTP configuration is absent. These
are confirmed remaining operating-credential gates; source deletion is blocked
by the Owner's condition that the full application must work first.

The following full deployment will include the public signed-download fix,
recovery body envelope and bound-receipt background activation. Pages now
publishes only a redirect; application testing/builds belong to the DigitalOcean
workflow. Main merge and the public bookmark change are still pending that full
runtime verification. No source project deletion is claimed.

The first full final-revision run,
[40241502372](https://github.com/salahassi/tenders/actions/runs/40241502372),
stopped in local checks before acquiring cluster credentials or changing the live
runtime. Frontend checks passed; backend had 1,456 passes and one obsolete test
that read the retired Supabase deployment workflow. That test now executes the
new fail-closed compatibility SQL against PostgreSQL 18, covering missing,
incorrect, partial and matching RPC signatures under a genuine non-superuser
role. Its complete 13-test file passes. The deployer invokes this same SQL after
restoration, before accepting worker availability. All other application code is
unchanged from the independently verified frozen-source 1,457-test revision.
Temporary encrypted HTTPS diagnostic objects have been removed after recording
the cause and repair; the private minimal restore bundle is retained.

Run [40242186686](https://github.com/salahassi/tenders/actions/runs/40242186686)
on `a5fad5c32342bc678fd689795538a47b73f2701a` passed every application,
compatibility and operations check, then published the new HTTPS, runtime and
frontend images. Re-pushing the browser image exceeded the registry's 900-second
upload window; no database/runtime mutation step ran. Existing browser/OCR images
remain available. Their package locks, Dockerfiles and every reachable local
module are byte-identical to the new revision (16 browser modules and 14 OCR
modules); the changed signed-download helper is outside both native module graphs.

A separate verified-image release uses the five already-published immutable
digests. Its read-only gate verifies the original successful application-check
step, exact repository/workflow/revision, unchanged application/operations/test
inputs, and identical static native-worker dependency graphs before obtaining
cluster credentials. Seven promotion guards pass, bringing ops guards to 92.
The actual local gate passed against GitHub evidence and both native revisions.
It then performs the same guarded restore, full live acceptance and bound-receipt
background activation; native images are executed on the destination before
schedules can be enabled. No application check is weakened or treated as passed
because an upload failed.

The first verified-image release,
[40244457918](https://github.com/salahassi/tenders/actions/runs/40244457918),
passed image/source provenance, private transfer and database initialization,
then stopped while reconciling existing Kubernetes resources. The HTTPS repair
had changed its image imperatively under a different field manager. The release
now aligns only that ownership-checked Deployment's image with the verified
digest before applying the complete declared runtime. Application source and
verified images remain unchanged; no source-project mutation occurred.

Verified release and background activation passed in
[run 40244862158](https://github.com/salahassi/tenders/actions/runs/40244862158),
job `121324177409`, workflow revision
`e25eec8eb7d23bdc4d0df6f29055a7a74f6e48d2`. Application/operations inputs match
validated source `a5fad5c32342bc678fd689795538a47b73f2701a`; native browser/OCR
inputs match their independently verified published revision. All ten permanent
Deployments reached readiness. Existing schema/37-row seed restoration was
preserved, and the exact recovery/claim RPC compatibility gate passed. Temporary
administrator Pod/Secret and runner credentials were removed.

All nine production smoke groups passed again against the final runtime,
including genuine Owner access, every frontend list, negative uninvited signup,
private bytes surviving Storage replacement and independent fixture/session
cleanup. All eleven background activation groups passed: workflow-bound receipt,
empty queues/paused external admission, owned immutable workloads, durable
dispatch configuration, denied/accepted private identities, manual worker
heartbeat, a second heartbeat driven by the actual relay, both native images
executing successfully against empty private queues, five-minute native schedules
and nonce Job cleanup. No Owner workspace fixture record, external model call,
portal request or email was created by these checks.

The application frontend is available at
`https://tenderdesk.129.212.166.115.sslip.io`. Owner password hashes and core
service credentials were preserved. The runtime still reports zero configured
provider keys and missing SMTP; source inspection confirms SMTP was configured
there. Models remain paused. Source project deletion and full external-feature
cutover remain pending the secure credentials and their verification. Main merge
and publishing the previous Pages bookmark redirect are the remaining release
steps; their exact results will be recorded after publication.

Release publication is complete. PR #8 merged into main as
`1afda0ed2f8c6b2e8607dd5f8fab7aed70617d47`. The old bookmark redirect passed
[Pages run 40245418635](https://github.com/salahassi/tenders/actions/runs/40245418635).
An anonymous read of `https://salahassi.github.io/tenders/` returned HTTP 200 with
the Kubernetes canonical destination and no old Supabase URL or application asset
references. The frontend now runs on Kubernetes; the previous bookmark redirects
there. The retired hosted API/reader workflows are absent from main.

All authorized core publication work is complete. AI/provider and SMTP values
are still absent on the new runtime, so external-feature verification and source
project deletion remain explicitly incomplete. The Owner has been asked to add
those values through repository Secrets without sending them in chat. No new
permission to merge or delete is being requested; deletion's existing operating
condition has not yet been met. Historical data remains on the source, outside
the new application's minimal data scope.

## Isolated Auth and Storage bootstrap on the existing DigitalOcean database

The Owner authorized implementation and live execution of the next compatibility
test. The existing GitHub Actions route already verifies Kubernetes access and
private managed PostgreSQL 18 access. The new test creates its own nonce-named
logical database, seven prefixed roles and temporary namespace; source data,
existing database objects and the published application remain outside its scope.

Implementation introduces digest-pinned Auth 2.197.0, PostgREST 14.18 and Storage
1.81.0 with private HTTP acceptance. It evaluates owner-role inheritance instead
of granting `BYPASSRLS`, checks genuine invitation acceptance and password sign-in,
and verifies user/anonymous denials, privileged service operations and private
file byte equality. This is automated fixture data in an isolated test database,
not workspace reference seeding or production acceptance. Storage is temporary;
no production file or user is copied. TLS, restricted containers, bounded public
results and ownership-checked SQL/Kubernetes cleanup are required throughout.

The optional runner source token is no longer a mandatory target-access gate.
Separate connected MCP reads already captured 116 scoped tables and 81,124 rows,
catalogs, deployed function sources and migration history privately. That capture
is not a consistent final cutover snapshot or a tested executable restore.

Verification before live execution: backend typecheck/build and all 1,430 tests
in 82 files passed. Pod specifications and credential/ownership guards passed
17 orchestrator tests, 10 pod-specification tests and four acceptance guard tests.
One frontend journey initially failed to observe its
expected region while both suites ran concurrently; the complete frontend rerun
passed all 233 tests in 38 files and its production build. Both package typechecks
and builds pass. Source revision, live workflow result and cleanup evidence will
be recorded after execution. No live bootstrap success or production migration
is claimed by this entry.

First live execution of source `73c6a4f0c405a83dc74731e754381cf0b72ab74f`,
[run 40234666954](https://github.com/salahassi/tenders/actions/runs/40234666954),
passed target access and inventory, then stopped in isolated database setup.
Database/role cleanup and namespace/credential cleanup were confirmed. No
compatible service or production restoration was established. The bounded error
did not identify the failing SQL operation, so the next revision adds SQLSTATE,
reviewed script line and fixed stage identifiers without publishing raw logs.
Public-schema ACL revocation also now explicitly assumes the new schema-owner
role, whose membership intentionally does not inherit into the admin session.

[Diagnostic run 40234986252](https://github.com/salahassi/tenders/actions/runs/40234986252)
on `6d22bd2d77cfad711ac860c5e10a0000d8f298c8` identified SQLSTATE `0LP01` at the
self-membership grant before the role transaction committed. PostgreSQL already
grants the role creator ADMIN; requesting that option again through the creator's
own membership is rejected. The revised grant requests only SET and disables
inheritance, preserving the separately granted administrative membership. The
same failure and corrected grant were reproduced in PostgreSQL 18.6 through the
embedded test engine. The committed role-graph regression executes both grants
under a genuine non-superuser session, then verifies the seven-role privilege
boundaries. Both failed live attempts confirmed database/role and
namespace cleanup; no production data was restored.

[Run 40235397571](https://github.com/salahassi/tenders/actions/runs/40235397571)
on `cf72efa1fac235c5ee2e6a09408cb7e526871a4d` created the isolated database and
started all three service sidecars after their startup checks and upstream
migrations. Post-migration fixture setup then reached its final metadata query,
which failed with SQLSTATE `42501`: the admin session deliberately does not
inherit Auth/Storage table ownership. The diagnostic counts now explicitly use
their respective owner roles before reporting aggregates. Database/role and
namespace cleanup passed. This establishes service startup, not completed HTTP
acceptance or production restore. An additional PostgreSQL 18.6 regression
reproduces the metadata read denial, verifies both owner-scoped counts and
confirms that the admin still has no inherited table-read privilege afterward.

Live acceptance passed on source
`72a10d63318f98071e5e12ca240b4f2c31ebc8bf` in
[run 40235951433](https://github.com/salahassi/tenders/actions/runs/40235951433),
job `121297449838`. Auth 2.197.0, PostgREST 14.18 and Storage 1.81.0 completed
their upstream migrations against a separate logical database on the existing
managed PostgreSQL 18 server. All seven acceptance groups passed: fixture
readiness, disabled public signup and protected administration, genuine invitation
acceptance/password sign-in for distinct users, cross-user row/write denials,
privileged service operations with ordinary-user RLS retained, two private
uploads with exact byte equality, and cross-user/anonymous/public file denials.

The live helper confirmed removal of the isolated database and seven roles, then
the namespace. Unconditional cleanup and temporary credential removal also
succeeded. The run reports `production_data_restored=false` and
`migration_ready=false`. This completes the isolated compatible-service
bootstrap checkpoint. Production owner/grant mapping, scheduler adaptation,
durable object storage, runtime credentials, source restoration, HTTPS/origin
configuration and application-level acceptance remain before cutover.

The final local guard set contains 17 orchestrator tests, 10 pod-specification
tests and four HTTP-probe guard tests, plus the PostgreSQL 18.6 regression for
the creator grant, seven-role inheritance and owner-scoped metadata reads. Both
application packages retain their passing typecheck/build results and all
1,430 backend / 233 frontend tests. No application source changed during the
bootstrap fixes.

## October 25 — Kubernetes access verified; migration compatibility inspection

After the Owner added the repository credential, attempt 2 of
[access run 40230328689](https://github.com/salahassi/tenders/actions/runs/40230328689/attempts/2)
passed against source `c7e2c8043d7f826e7c224dff1feedaea7af8b6cc`. The Kubernetes API
reported ready on version `v1.37.0`; both nodes were Ready and all 14 pods were
Running. The authenticated identity can create Deployments in `tenderdesk-dev`.
The original cluster CA, certificate and hostname verification remained enabled.
The runner deleted its temporary credentials after the check. This verifies an
operational route through GitHub Actions; the development container's direct
Envoy connection is still a separate limitation.

The next change extends the workflow to inspect the managed database from an
isolated temporary Kubernetes Job using the database's private endpoint and
`sslmode=verify-full`. The database queries are read-only. Job resources and
credentials must be removed after inspection. An independent source management
API probe checks whether source database metadata can be read with the existing
repository credential. These probes do not restore data, run migrations, deploy
the application, change firewalls, or enable external processing.
The helper passed syntax validation, 14 offline checks, and a mocked resource
lifecycle covering create-only ownership, Job-to-Secret garbage collection,
read-only SQL, strict TLS, restricted pod settings and cleanup. Workflow syntax
and output-whitelist checks also passed. Application source is unchanged from
the preceding 233 frontend/1,430 backend test and typecheck/build results.

Source `d6ee54fb2d1904788eb1f68d59d5dde0b20cc6c7` ran as
[migration preflight 40232030191](https://github.com/salahassi/tenders/actions/runs/40232030191).
Kubernetes access passed again. The temporary client Job successfully connected
to the private managed PostgreSQL endpoint with `verify-full` and completed the
catalog query. PostgreSQL 18 reports CREATE ROLE and CREATE DATABASE privileges
without superuser; the selected database has zero public tables and no Auth or
Storage schema. `pgcrypto`, `uuid-ossp`, `pg_trgm` and `pg_cron` are available but
not installed. `pg_net` and `supabase_vault` are unavailable. The existing
dispatcher therefore cannot be transferred unchanged. These metadata checks do
not prove that the complete compatible-service bootstrap will work.

The source probe stopped with `SUPABASE_ACCESS_TOKEN_MISSING`; the overall run
correctly failed rather than reporting migration readiness. Target namespace,
Job and credential cleanup succeeded, and the unconditional cleanup steps passed.
The next required credential is repository secret `SUPABASE_ACCESS_TOKEN` for
authorized source management access. No source data was exported, no database
schema was changed, and no application or data cutover has occurred.

## October 25 — Prepare verified DigitalOcean Kubernetes access

The Owner requested access to the existing `tenderdesk-dev` Kubernetes cluster
and the start of deployment work. DigitalOcean's management API is reachable;
the development environment's Envoy proxy rejects the Kubernetes upstream with
`CERTIFICATE_VERIFY_FAILED`. The available environment configuration tools do
not expose upstream certificate-authority trust settings.

Stage 7 (operations): preparation introduces a separate GitHub Actions access
check for cluster `a6093a76-a2d6-47fd-8697-579d41ed316f`. The runner uses the
original cluster certificate authority and a short-lived kubeconfig, preserving
certificate and hostname verification. Public logs contain only aggregate
operational results. The workflow is read-only and does not deploy an application
or modify the managed database. See `DIGITALOCEAN_KUBERNETES.md` for setup and the
distinction between a connection check and application migration.

The workflow passed YAML, shell and embedded Python syntax checks, plus eight
offline checks covering the valid configuration and rejection of wrong targets,
disabled TLS, proxy and hostname overrides, executable authentication, missing
CA and mismatched context. A live request to DigitalOcean's management API
confirmed that its short-lived kubeconfig contains the expected endpoint,
embedded CA and token-only identity with verification enabled. This is not a
Kubernetes connection test. The frontend passed 233 tests in 38 files, typecheck
and build. Backend dependencies were refreshed from the unchanged lockfile after
missing packages prevented the first typecheck. The corrected environment passed
all 1,430 backend tests in 82 files, typecheck and build.

The first branch push at `80fc8a5` was accepted, but GitHub rejected the workflow
before allocating a job. Runtime paths were moved from job-level expressions
into an initial runner step. Corrected source `c7e2c8043d7f826e7c224dff1feedaea7af8b6cc`
started [access run 40230328689](https://github.com/salahassi/tenders/actions/runs/40230328689).
The runner initialized successfully, then stopped because the repository secret
`DIGITALOCEAN_ACCESS_TOKEN` is missing; its unconditional cleanup succeeded.
The integration can read and push workflows but GitHub returned HTTP 403 for
Actions secret administration. The remaining immediate action is to add that
secret through the repository settings and rerun the same check. No successful
Kubernetes connection, deployment, full application migration, or environment
publication is claimed. The Owner selected full migration to DigitalOcean,
including the backend and data, rather than retaining hosted Supabase. The
application still depends on Supabase Auth, Storage, Edge Functions and database
functions; compatibility, source backup and restoration must be validated before
cutover. Access preparation is the first prerequisite, not the complete migration.
The existing DigitalOcean managed database is PostgreSQL 18 in `sfo3` and reports
`online`; extension, role, schema and application compatibility have not been
tested. The current environment has no source Supabase access token, database
password or service-role variable. Source export access and target object
storage remain migration prerequisites, separate from the Kubernetes access gate.

## October 23 — Isolate OCR processing and make its waiting state explicit

Owner requested a project audit and a separate worker, appropriate status and
distinct color for notices requiring OCR. The referenced conversation
`01a168ad-d7d3-7587-a6a1-f7337035a06a` is not accessible with the current tools;
its additional requirements have not been verified. Repository decisions and the
current request are the available scope.

Live inspection found API 88, worker 124 and source-browser 3 active. At the
inspection, 17 assessment jobs reported NOTICE_OCR_PENDING; the native OCR queue
contained 14 queued and 39 ready receipts. Counts include retained history and
are not a count of current undecided notices. Browser processing previously
consumed the same nine-minute budget before OCR could begin.

Stages affected: collection/background (3), assessment (5), operations (7).
Implementation complete: independent browser and OCR GitHub Actions jobs,
each with its own runner, concurrency group and execution budget; a purple
Awaiting OCR review group and job badge; suspend main-queue polling while a
current native OCR receipt is queued or running. Existing evidence, leases,
attempt budgets, model requests and human bid decisions remain authoritative.

Verification on the reconciled source: **1,430 backend tests across 82 files**
and **233 frontend tests across 38 files** passed, with both packages' TypeScript
checks/builds and all three Deno entrypoint checks. The final inbox-count guard
also passed the 49 focused frontend regressions and rebuild. SQL regressions
prove queued/running OCR does not consume parent attempts or stop other jobs;
ready/failed receipts continue normally, and changed sources, authorization or
cancellation are not stranded. Worker tests exercise OCR-only gateway actions
and independent limits. UI tests cover grouping, purple badges, filters,
cancellation, preserved decisions, and not presenting parent retries as OCR
progress. These are local/fixture results, not hosted OCR or visual acceptance.

Merged the independently released saved-draft recovery from main `5527354`.
That real 67-section draft is already recovered; updated-notice regeneration,
actual Word downloads/review, recovery and multi-role/mobile acceptance remain
separate. At 20:15 UTC, the contextual-scope reassessment was still queued;
read-only production counts showed 49 ready OCR receipts, eight stale queued
receipts and five OCR-waiting parent jobs. Historical queue totals are not
current work counts. No model verdict or business document was invented.

Deployed source `23264c71b75460fbd44546d09f8c493459fa1207`:

- Canonical migration `20261023160416_isolate_notice_ocr_waits.sql` is applied as
  hosted `20261023201738`. Live readback confirms both queue selection and wake
  predicates use the new guard. The helper remains inaccessible to anonymous,
  authenticated and service roles directly. Security advisor categories/counts
  are unchanged from the preflight baseline. No Edge Function redeployment was
  required; health returned 200 and anonymous API/worker/browser access 401.
- [Pages run 40018120737](https://github.com/salahassi/tenders/actions/runs/40018120737)
  completed successfully, including the full tests, types and Deno checks.
  Seven served HTML/entry/Review/Jobs/CSS assets match the local build byte for
  byte, including the purple Awaiting OCR state.
- [Public-reader run 40018121841](https://github.com/salahassi/tenders/actions/runs/40018121841)
  started both independent jobs at 20:17:58 UTC. OCR succeeded at 20:20:15,
  after 2m17s, while the browser reader continued and succeeded after 5m22s.
  The OCR job installed Arabic/English tools, authenticated and checked its
  queue. No eligible current OCR request existed in that run, so it is not
  represented as a newly completed OCR document. Existing ready text and all
  original hashes, attempts and leases were preserved. Future real scan
  extraction on this separate runner remains distinct from this verified launch.

Current continuation snapshot (20:21 UTC): three undecided, unexpired notices
were still in the OCR reading stage awaiting application of saved receipts;
36 assessments were awaiting model work and six current assessments were
blocked by MODEL_CORRECTION_EXHAUSTED. These are not claimed complete. Next
acceptance work is to inspect those saved validation failures, complete the
contextual-scope reassessment, regenerate the recovered draft against current
notice evidence, and verify actual Word downloads/review. Hosted multi-role,
mobile and original-inclusive recovery journeys retain their separate gates.
Authenticated browser visual QA was not performed in this session.

## October 23 — Completed proposal recovered after notice enrichment

The Owner requested recovery of an older proposal whose writing and review
had finished. Read-only diagnosis identified two distinct events: an earlier
content-policy false positive on a joined confidentiality term, already fixed
by the deployed policy alignment, and a subsequent public-notice enrichment.
The enrichment adds substantive requirements. Recovery must not relabel the
saved model results as based on those newer requirements.

Stages 5–7: the implementation permits only the final local assembly when every
model step is finished and the notice is the sole changed proposal input.
The immutable input snapshot, hash, evidence revision, completed work and model
receipts remain intact. Changes to the RFP, original company evidence, review
inputs, template or rates continue to reject resume. Cancellation, supersession,
membership, expected revision, leases and ordinary retry guards remain enforced.
The recovered version records its original and observed notice hashes, includes
a blocking review question, and remains downloadable as a draft. Final approval
requires regeneration with current evidence even if that question is resolved.
The interface identifies the recovered draft and explains unsafe resume requests.

Verification: regression tests cover recovery, unchanged saved outputs,
idempotent retry, draft export, final-approval rejection, updated regeneration,
changed inputs, unfinished review, cancellation, role/revision guards and changes
after resume. The managed development environment disconnected before local
tests could run. Isolated branch source `6809e4c0af65f49bef03a97f5a1c4f1cb2a563a8`
passed [verification run 39977583634](https://github.com/salahassi/tenders/actions/runs/39977583634):
**1,422 backend tests in 82 files**, **230 frontend tests in 38 files**,
both TypeScript checks and both production builds, using locked dependencies.
The branch-only verification workflow has no deployment step or production
credentials and is excluded from main. These fixture results are separate from
the hosted acceptance below.

Released source `835c8d61f056ba2a31882614fa70896ff5fdcba6` passed
[Pages run 39978890067](https://github.com/salahassi/tenders/actions/runs/39978890067),
including the same full test counts, both TypeScript checks, all three Deno
entrypoint checks and the frontend build. Pages publication completed at
15:35 UTC. The public sign-in page is reachable and the served
`ProposalEditor-DsOerFbS.js` contains the historical-draft notice.
Canonical migration `20261023150859_recover_completed_proposal_draft.sql`
was applied as hosted migration `20261023153048`. No Edge Function source
changed or required redeployment. The helper is private and cannot be invoked
by authenticated or service roles directly. Post-deployment advisor categories
and counts are unchanged from the preflight baseline.

Hosted acceptance: the existing, revision-checked Owner `job.action` retry
resumed only the final assembly at 15:32:48 UTC. This established job-scoped
retry path checks that job's unsettled usage; unrelated accepted model requests
remain untouched. Whole-plan retry retains its existing workspace usage guard.
The normal worker completed assembly at **15:33:08 UTC**. The original plan
is completed with no error and its proposal now has an active draft version
containing **67 sections**. The **95 completed model steps**, all **557 usage
receipts associated with the plan's jobs**, frozen-context hash, input hash and
original evidence revision **196** are unchanged across recovery. No additional
model request was made. Exactly one recovery audit and one finalization question
were created. The approval gate confirms that regeneration is required.

The real technical and financial draft `export.prepare` commands both passed
an authenticated transaction check; each snapshot contains all saved sections,
the recovery marker and warning. The check was rolled back to avoid leaving
test export requests. Authenticated browser visual inspection and actual DOCX
downloads were not performed in this session. This completes recovery of the
saved draft; an updated proposal against the enriched notice has not been
generated or approved.

The local execution transport remained unavailable at handoff. Released main
is the canonical complete change, including tests and this status record; the
local working copy needs reconciliation with main when execution returns.

## October 23 — Contextual scope comparison from database evidence

The Owner clarified that scope must follow the meaning of requested outcomes and
the company's documented specialization, without literal keyword requirements,
an exhaustive exclusion list or hardcoded business domains. A traced production
assessment originally excluded unrelated work, but verification demanded an
explicit exclusion and correction changed it to uncertain. This was an
interpretation defect, not a failure to read the notice.

Implemented a versioned, trusted scope-comparison policy shared by classification,
verification and correction. The policy permits cited semantic mismatch while
keeping capacity and eligibility evidence independent. Company specializations,
interests and exclusions remain supplied database records; no business data or
classification lookup table was added. Existing scope settings are preserved.
New applicable phases pin semantic revision 3; historical revisions 0–2 and
accepted request inputs remain unchanged. No database migration is required.

The frontend now displays the saved scope reason for current uncertain results
and describes optional exclusions and contextual matching. It no longer labels
every uncertain result as missing a full tender document. Stale explanations are
hidden during reassessment.

Local acceptance: 1,413 backend tests across 82 files and 227 frontend tests
across 38 files pass, with both packages' typecheck/build and all three Deno
entrypoint checks. Independent review found no blocking defect in policy
selection or request compatibility. Database fixtures exercise current verified knowledge,
indirect relevance, unrelated work without exclusions, unknown credentials and
knowledge edits. Model responses in these tests are explicit fixtures; they do
not establish live model accuracy.

Source `98420bf11226a60122b0db519597c6edd652571d` is deployed: API **88** and
worker **124** are ACTIVE, with all 37/58 retained source files matching the
tested package. No database or saved workspace scope configuration changed.
Health returns 200 and unauthenticated API/worker access remains denied with
401. [Pages workflow 39952862318](https://github.com/salahassi/tenders/actions/runs/39952862318)
passed the complete checks and published the frontend. The served HTML and
entry, Settings, Review and Opportunity Detail bundles match the local build.

The reported real notice was queued for reassessment through the normal audited,
revision-checked Owner command at 12:24 UTC, preserving its prior assessments
and undecided business status. Plan `c3f5cecd-01fd-4561-a868-d1fdc85101db`
refreshed the published notice successfully. At 12:28 UTC it was waiting behind
existing eligible queue work, without a new model attempt or completed result.
Live semantic acceptance for this notice remains pending; neither the fixture
results nor successful deployment are represented as a completed model verdict.
Authenticated browser visual acceptance was not performed for this text change.

## October 22 — Repair notice reading and assessment attention states

Owner explicitly requested fixing the reading and classification problems after
live diagnosis found 54 Review attention items: 20 Amman detail redirects, eight
Water Ministry manual-access blockers, six Royal Jordanian content-policy
blockers, nine non-tender Aramco service pages, ten stale completed assessments
without rescheduling, and one current assessment with uncertain scope. Another
25 unexpired discoveries were actively being assessed. Source-list collection
success alone is not full detail-reading or assessment acceptance.

Live cleanup has archived the nine verified evergreen Aramco service pages using
the normal Owner-authorized opportunity decision command with current revisions,
audit and idempotency. These were undecided records without proposals, attached
to the already rejected source. Saved records and assessment history remain
available in the archive. No actual tender or selected opportunity was removed.

Reader, per-assessment evidence currentness and Review state corrections are
implemented and deployed. Hosted recovery below distinguishes completed reading
from queued or running assessment work.

Local classification acceptance: the invoker discovery view compares consumed
notice/company/scope inputs rather than unrelated workspace revisions, and the
scheduler also requeues genuinely changed completed assessments. Sixteen new SQL
regressions and 111 focused tests pass, including membership isolation, retained
model work and skipped declined/rejected discoveries. Read-only live comparison
found 37 previously saved assessments with unchanged inputs (including expired
notices); the equivalent query across 109 plans took 1.08 seconds. The migration was
reviewed independently and deployed. The actual discovery view took
0.76 seconds across the workspace. After deployment and the audited cleanup,
the new UI grouping finds 34 genuine reader blockers, eight excluded notices,
seven current uncertain-scope reviews, one qualified inbox notice and 21 active
assessments; none of the prior stale completed records remains mislabelled as
not started. The normal assessment scheduler was invoked once for actual input
changes. Counts remain live and may change as existing jobs complete.

Frontend adds a separate Scope to review tab for current uncertain assessments;
pending scheduling, saved model requests and OCR waits remain under Assessing.
Actual blockers show their specific cause. Frontend typecheck/build and all 225
tests in 38 files passed, including OCR provenance and progress messages.

Actual public-page preflight retrieved six Royal Jordanian descriptions through
readonly fields while excluding hidden login labels, and seven of eight Water
Ministry notices through tender-only content and attachments. All 13 successful
descriptions pass the exact live PostgreSQL content-policy function in an isolated
PostgreSQL test. The remaining Water notice requires OCR. Twenty Amman anonymous
public detail navigations returned matching titles. Additional canonical reads
covered 12 Potash, nine NEPCO and two Phosphate notices; scanned PDFs and image
advertisements exposed by these reads are being handled explicitly. None of
these preflight counts substitute for hosted ingestion or assessment completion.

Fresh Etimad Chromium preflight at 23:12 UTC returned six real tender records
through saved selectors and bounded sanitized DOM, without a model request.
The production job still uses its old cached page until the corrected browser
worker is published and a new normal collection is queued.

Reader acceptance now includes 20/20 complete Amman navigation/enrichment
executions with matching titles and deadlines. All 20 descriptions also pass
the live content-policy definition in isolated PostgreSQL. Actual attachment
coverage is retained: two notices fully read, 18 partial due to scanned or large
PDFs. A durable OCR queue and native Arabic/English worker have passed 66 focused
tests, including 13 SQL queue tests. Four real public files (two Water Ministry
PDFs and two Phosphate images) produced OCR text with measured confidence 65–95;
end-to-end hosted OCR remains pending publication.

PDF and OCR restricted-content checks now use the same explicit classification
label/credential guard as model processing. Ordinary confidentiality clauses
remain usable evidence. A small SQL alignment migration is live and verified:
joined words such as confidential-information pass, explicit CONFIDENTIAL:
labels remain blocked, and browser/anonymous function permissions remain denied.
The model-policy regression suite passed 77 tests.

Final local regression: 1,340 backend tests across 79 files passed; backend and
frontend typecheck/build plus all three Deno entrypoint checks passed. Independent
reviews confirmed repeat listing ingestion preserves already enriched notices,
queue receipts are scoped to source revisions, stale requests do not starve the
queue, and archived opportunities cannot receive late OCR/browser results. Native
OCR pins validated public addresses with official TLS host verification and one
download-plus-extraction deadline. All four database migrations are now applied;
API 85, worker 120 and source-browser 3 are deployed. Readback matched all
36/57/7 reachable files respectively; health returned 200 and unauthenticated
API/worker/browser requests returned 401. Seven tested source configurations were
activated through revision-checked audited commands. The 34 reader-blocked
assessments and five validated classifier failures were resumed through their
existing jobs. Hosted reading/OCR recovery and frontend publication follow.

Etimad's final real browser check found six matching tender records and a matching
detail title with 1,580 readable characters. Optional date/location tabs returned
no content and now produce explicit partial-coverage warnings, retaining the
available scope. The saved listing deadline selector excludes duplicate parent
text. Another live classifier diagnosis found equivalent decimal formatting
(300 versus 300.00) and Arabic classification ordinals rejected as unsupported
numbers; narrowly scoped validator corrections and negative regressions are being
completed. All five actual rejected public claims now pass the corrected validator
against their official notice text; 168 focused grounding/recovery tests passed.
Existing bounded recovery revalidates saved reports without resetting budgets.

October 23 hosted follow-up: source revision `4f39895` passed the complete Pages
workflow `39874062088`; the live Review bundle exposes Scope to review. Native
workflow `39874075534` completed the first real OCR request, and `39875536172`
completed public browser/OCR work. Etimad is now healthy with **six actual saved
tenders** (00:04 UTC). Its public browser listing required no CAPTCHA in that run.
The separate detail-tab warnings continue to represent missing tab coverage.

Production verification found and corrected three further integration issues.
The tested Amman host was absent from the deployment allowlist; it was added with
an audit event while preserving the dispatcher secret, then affected work was
retried normally. Configured DOM sources and notice-reading prerequisites were
waiting behind new model requests; migration `20261022235500` adds alternating
priority, preserving admission, owner fairness, source revisions and leases.
Pending/stale OCR or browser requests get no priority bonus; current OCR receipts
must all be ready. The queue regression group passed 125 tests.

MWI returned 403 when negotiating compression, despite its public page being
available. Bounded public requests now use identity encoding; policy and size
checks remain intact. Exact live preflight collected eight notices, read all
eight details (four complete/four partial), received HTTP 200 on all 31 requests,
and read 21 pages by Arabic/English OCR. Production collection then returned
healthy with eight saved notices. A real mixed 24-page PDF also demonstrated why
OCR failure must retain existing text: controlled low-confidence failure now
keeps its 22 readable pages and explicitly lists the two missing pages. This is
controlled local evidence, separate from hosted OCR acceptance.

The MDLF retry was independently traced to an awarded contract mislabeled in the
portal's application-period table. Its PDF was verified as a September 2025 award;
the undecided record had no proposals and was archived through the normal audited
command, retaining its identity to prevent reopening on later polls.

Final follow-up runtime is API **87**, worker **122**, source-browser **3**. All
36/57/7 reachable deployed files match canonical source. Backend typecheck/build,
all three Deno entrypoints and **1,359 backend tests across 79 files** pass;
frontend remains at **225 passing tests across 38 files**, typecheck/build pass.
Live recovery is ongoing: at 00:06 UTC, 12/20 Amman notices had saved detail reads,
Etimad had six saved records, and no Review attention blocker remained. Pending
OCR and model assessments are still processing; they are not claimed complete.

The same follow-up source revision `144b604` passed Pages workflow `39876252686`.
Native workflow `39876365560` completed eight current-context OCR receipts in
total, but two Etimad detail requests timed out. Those requests exposed a durable
retry defect: the first failed browser receipt was returned repeatedly without
using the remaining native attempt. Migration `20261023001313` is now applied:
transient failures use the existing two-attempt limit; exhausted browser/OCR
requests become explicit terminal read failures, retaining the original receipt
error and attempt history. Seventy focused queue/browser SQL tests passed.

The native reader now also preserves the existing notice when an optional tab
click or panel read times out, while retaining URL-change and initial-navigation
guards. Worker diagnostics identify the failing stage without logging page text.
Thirty-two distinct focused tests and a real local Chromium overlay regression
passed. The overlay was a synthetic local regression, not proof of the earlier
hosted timeout's exact cause. Publication and hosted detail recovery follow.
The complete final backend suite passes **1,371 tests across 80 files**, with
typecheck/build passing; the frontend and Edge source are unchanged from the
previously verified deployment.

Source revision `f3cd6b4` is published. Native run `39877255970` has produced four
current ready Etimad detail receipts (4,757–6,218 characters); three retain explicit
optional-tab gaps and one read all configured tabs. This is hosted browser
acceptance; subsequent incorporation into notice evidence is still queued. The
first hosted MWI detail and five Royal Jordanian details have also been saved.

Independent review found a browser-completion race when the parent briefly
resumed while its native read was still running. Migration `20261023002056` is
applied: exact current browser receipts may finish during that parent lease,
without altering any parent fields. Canceled/stale inputs and expired browser
leases remain rejected. All 35 focused SQL tests and backend typecheck pass.
The full backend suite now passes **1,376 tests across 80 files**. Native workflow
`39877255970` completed successfully with four rendered details and no browser
failures. The original two timeout receipts still await their bounded retry.

Commit `3eae288` published the completion-race fix through the GitHub connector;
local source was synchronized to that exact commit after CLI credentials expired.
The two legacy first-time Etimad timeout receipts were requeued through a narrowly
scoped audited repair, retaining their hashes, original errors and attempt counts.
Native workflow `39877255970` attempt 2 has now read both successfully: **all six
Etimad detail receipts are ready**, including the two second attempts. Parent
assessment processing remains separate from this completed browser reading.

Further hosted MWI recovery exposed a short-notice error-classification defect:
temporary attachment downloads were reported as permanently unresolved content.
Transport failures now retain timeout/retry codes; sufficient readable HTML
remains partial, corrupt PDFs remain distinct, and backend policy/currentness
errors retain their exact codes. Ninety-eight focused tests passed. Worker **123**
is deployed and all 57 reachable files match source; API remains **87**, browser
gateway **3**. The affected blocked MWI job was resumed through its normal audited
command. The full backend suite passes **1,386 tests / 80 files**, backend
typecheck/build and the changed worker Deno check pass. Frontend remains unchanged
with 225 passing tests. End-to-end processing of the backlog is still ongoing.

Commit `3914ba8` passed Pages workflow `39878768049`; native run `39877255970`
attempt 3 also completed successfully. Hosted OCR is now incorporated into the
Phosphate notice and four Amman notices. Amman has 17/20 saved detail reads,
Royal Jordanian 6/6, MWI 3/8, and all six Etimad browser receipts are ready.
These counts at 00:40 UTC deliberately separate original detail reads from final
assessment completion. Partial pages and unread attachments retain their flags.

Queue diagnosis found otherwise eligible work repeatedly waiting for cron after
durable reader handoffs and graph-only progress. Migration `20261023003552` is
applied: immutable audit receipts prove the released lease/revision, allowing the
existing wake endpoint to continue other due work, or a genuinely advanced graph
checkpoint. Replaying an old checkpoint does not create a wake chain. Active
leases are stored only as hashes; the existing ten-second throttle, capacity,
reservation, restore, executor and concurrency guards remain intact. A narrow
partial index covers the new audit proof lookups. All 160 focused SQL tests and
backend typecheck/build pass. Manual dispatch batches stopped at 00:41 UTC;
hosted automatic wake/receipt acceptance is being verified separately.
The complete backend regression now passes **1,399 tests across 81 files**;
frontend remains at **225 passing tests across 38 files** with unchanged source.

Native processing retains the existing best-effort GitHub schedule. Manual
workflow runs were used for this recovery; scheduled runs were observed at 19:01
and 22:14 UTC, and run `39879578173` succeeded at 00:41 UTC on October 23,
so a reliable five-minute hosted cadence is not established by
these tests. The user-facing pending states remain truthful while work waits.

Publication acceptance: source revision `e068344` passed the complete Pages
workflow `39879805420`, including both typechecks, all three Deno entrypoints,
both regression suites and frontend publication. The deployed runtime remains
API **87**, worker **123**, source-browser **3**. At 00:50 UTC, hosted notice
evidence contains **20/20 Amman**, **6/6 Etimad**, **6/6 Royal Jordanian** and
**2/2 Phosphate** detail reads. Twelve Amman and four Etimad reads explicitly
retain partial coverage; seven Amman notices and one Phosphate notice contain
saved OCR provenance. These are database-confirmed reads, not listing counts.
MWI has **3/8** saved detail reads: other work still includes OCR and two
retryable transport failures. Independent Deno checks of the three previously
failing public detail URLs returned HTTP 200 with both default and HTTP/1.1
clients; those local results do not establish the cause of the Edge failures.

The same snapshot has **62** unexpired assessments processing, **seven** current
uncertain-scope reviews and no terminal Review attention item. Processing is
not completion: 49 assessments await model work, seven await OCR, four are
queued and two retain timeout/temporary-fetch errors. All original 34 reader
blockers have left terminal attention (33 processing, one expired), but their
final assessment outcomes are not yet accepted. Twelve of 13 approved sources
are healthy; MDLF remains unavailable and its verified award stays archived.

Read-only acceptance at 00:52 confirms automatic continuation after the single
00:41:37 kickoff: eight notices saved, 23 classifier jobs advanced, 21 graph
checkpoints persisted and 19 retained automatic wake records. A reader handoff
at 00:48:22.879714 matched its automatic wake at 00:48:23.033775, proving the new
reader wake branch on hosted work. Every observed graph turn included a provider
attempt; the graph-only wake branch has regression coverage but no hosted
acceptance in this window. No classifier completed in this observation window.
Six ready OCR receipts remain eligible and rank 2–7 on the next reading-priority
cycle; one newly queued MWI OCR request prompted native run `39877255970`
attempt 4, which completed successfully. At 00:53 UTC all eight current OCR
receipts are ready and none is queued/running. Incorporation into notice
evidence and final classification remain pending. That manual native run is
separate from automatic backend dispatch.

Fresh Supabase advisors retain the existing categories: 14 private RLS tables
without browser policies, 23 authenticated definer-function warnings, disabled
leaked-password protection, 114 uncovered foreign keys and five unused indexes.
This repair does not claim an otherwise clean security/performance advisory
report or change those unrelated access and project settings.

## October 22 — Replace registration pages with tested tender listings

Owner explicitly requested finding actual tender pages, testing extraction before
addition, and removing non-listing sources. Current 35-source snapshot and fresh
HTTPS probes are preserved locally. Registration portals and ministry referral
pages were removed through audited source rejection and pending-job cancellation,
retaining existing opportunities and history. The published default directory
hides rejected sources and retains an explicit Removed sources filter.

A generic records extraction layout supports real public tender cards/tables
with saved selectors, distinct detail-URL identities, raw closing dates and
optional source-timezone calendar-day exclusion of past deadlines. No
institution-specific runtime registry is added. Preflight source results, complete
regression, live audited changes and publication will be reconciled below.
Fresh Royal Jordanian listing/detail GETs exposed an optional hidden Bootstrap
login dialog incorrectly treated as a login wall. Public HTML parsing now
distinguishes hidden dialogs from active password forms; HTTP authorization and
CAPTCHA/access-prohibition guards remain enforced, with regressions for each.

Preflight passed before activation: canonical collector requests retrieved Royal
Jordanian **6**, NEPCO **9**, Arab Potash **12**, JPMC **2**, Water Ministry **8**;
MODEE explicitly reported **0** current tenders. One original detail GET from each
nonempty listing returned HTTP 200 and matching content. Fresh Chromium Etimad
`PageNumber=1` returned HTTP 200 and **6 distinct references/detail URLs**. These
43 preflight notices are real public-page results, separate from database ingestion.
Unsuccessful SFD/Birzeit checks and PPU's inspected closed notice were not added.

Live administrative execution on the verified Owner's explicit request used the
normal revision/idempotency/audit commands: **15 sources rejected**, associated
source jobs canceled, existing opportunities/history retained; **seven tested
existing candidates configured, approved and queued**. JONEPS's homepage was
replaced by the observed public invitation-list URL, kept paused because its
JavaScript detail navigation lacks a tested collector. Seven remaining candidates
are not enabled. The reference catalog now contains 20 destinations (SA 2, JO 10,
PS 8), including ten static extraction profiles; repeat seed never restores
retired source decisions or enables collection.

Local acceptance passed **1,225 backend tests / 72 files**, **213 frontend tests /
38 files**, both package typechecks/builds, and all three Deno entrypoints.
Deployed **API v84 / worker v119** reachable files match canonical source. Initial
live jobs exposed the old five-host deployment permission list. Only the seven
tested exact hosts were appended with an administrative audit, preserving existing
hosts and the dispatcher credential; affected jobs were retried through commands.
Live source completion and Pages publication remain to reconcile.

Hosted follow-up: Royal Jordanian **6**, NEPCO **9** and JPMC **2** real notices
are now saved in the database, with successful jobs and healthy source status.
Arab Potash, Water and MODEE retain due collection jobs after the host-policy
retry. They share the existing serialized workspace queue with notice assessment;
preflight success is not being substituted for a completed hosted job.

[Browser workflow 39843278634](https://github.com/salahassi/tenders/actions/runs/39843278634)
succeeded at **19:49:32 UTC**, reading the actual Etimad job through the deployed
gateway and publishing **8,491 text characters / seven links** as ready rendered
evidence, without a CAPTCHA. Etimad is approved at revision 3; its ordinary
grounded extraction/ingestion continuation remains due. A real human-entered
CAPTCHA is still not claimed. Health 200 and anonymous API/worker denial checks
pass. No synthetic workspace record, bidder account, purchase or submission was
created.

Follow-up queue inspection found three corrected static-fetch retries waiting
behind unseen assessments created by the first successful collections. A narrow
queue migration alternates static-listing preference within the existing
background class by queue cycle. The other cycle retains owner service ordering;
proposal/poll/local slots, eligibility, current source revisions and exclusive
leases remain unchanged. New automatic/model requests have no general preference;
only the ready-browser handoff described below qualifies. Regression covers static retry progress, the next unseen assessment,
proposal priority, future eligibility, exclusive leases and zero provider calls.
The browser-ready handoff gets the same alternating preference only while model
admission has capacity and the exact current page is ready. Its pending-browser
state is consumed once; accepted model requests keep ordinary poll fairness.
Additional SQL regressions cover available and full model capacity.

Hosted queue correction: all **six new static sources have now succeeded** and
are healthy, saving **37 real notices** (RJ 6, NEPCO 9, APC 12, JPMC 2, MWI 8,
MODEE 0). The static migration is live and the private queue helper remains
inaccessible to authenticated clients. The 90-test focused queue/browser/wake
suite passes with the ready-browser follow-up, also now live. Full regression
after the static change passed **1,227 backend tests / 72 files**; the final
browser-handoff regression is running.

Final local regression passed **1,229 backend tests / 72 files**, with backend
typecheck/build; frontend remains at **213 passing tests / 38 files** with its
published build. Both queue migrations are live and retain private function
permissions. At the final live readback there are **13 approved sources: 12
healthy and Etimad in model extraction**, with **15 removed** and **seven not
enabled** (six proposed, JONEPS paused). All **37 new static notices** are saved.
Etimad progressed from browser wait into its saved model graph at **20:03 UTC**;
its first real model request settled. Final notice ingestion for Etimad remains
asynchronous and is not represented as completed collection.

Source `612748a` passed [Pages 39843169983](https://github.com/salahassi/tenders/actions/runs/39843169983).
Published index and Sources assets match the tested local build exactly. The
fifteen removed rows remain available only through the explicit removal filter.

## October 22 — Browser collection, human verification and legacy review resume

Owner requested a JavaScript/CAPTCHA solution and recovery of the pictured legacy
proposal. Its 67 saved writing steps and ten completed review batches remain
intact. Three old review graphs had exhausted their bounded corrections; Resume
only requeued those graphs. The corrected command replaces an obsolete review
input once with an explicitly versioned, citable draft snapshot for workflows
1–3, retaining prior receipts/budgets. Newer-plan guards prevent resuming a
superseded canceled workflow, and its obsolete UI Resume button is hidden.

Migration `recover_legacy_review_on_resume` is live. The existing evidence guard
verified unchanged inputs, then only the three blocked review jobs were replaced.
Their next execution exposed a separate stale-input blocker: unrelated verified
library additions changed the global evidence revision. Migration
`preserve_frozen_knowledge_on_addition` compares the exact original knowledge
entries while leaving new additions for future plans. Existing source edits,
removal, loss of verification, RFP changes and permission checks still fail closed.
Every saved writing step remains retained; final review and export are pending.

Migration `source_browser_queue` is live. JavaScript/challenge pages enter a
bounded Chromium queue, serviced by a scheduled GitHub Actions worker using
short-lived GitHub OIDC identity. Its dedicated gateway verifies the signed
issuer, audience, repository, main ref and exact workflow before allowing only
leased browser operations. No stored management token or service key is supplied
to Actions. Browser destinations require HTTPS/public DNS;
leases, source revisions and membership are checked before publication.
Human image-code challenges appear in source details with an expiring,
challenge-bound Owner answer. Answers are consumed once and redacted from audit.
Browser state uses authenticated AES-256-GCM encryption, workspace/host binding
and a four-hour server expiry; cookies and credentials never enter client reads.
A recurring challenge needs a new human answer. Unsupported login/verification
remains an explicit blocker rather than fabricated collection.

Live browser evidence: Chromium retrieved six actual Etimad notices and their
detail links, where raw HTTP received the JavaScript human-verification page.
Human-answer/session isolation are covered locally; a real human-entered
production CAPTCHA has not yet been exercised. AbortError code 20 is normalized
to a retryable source timeout. Local verification passed: **1,219 backend tests in
71 files**, **212 frontend tests in 38 files**, both package typechecks/builds and
frozen Deno checks for API/worker. Security advisories retain the existing
categories; the additional private tables intentionally have no client policies
or grants, and the new authenticated verification read enforces Owner authority.
Pages publication [39800085620](https://github.com/salahassi/tenders/actions/runs/39800085620)
passed at source `d7c3268`. The initial API/browser workflows exposed an absent
repository deployment credential; no secret was requested or created. The
connected Supabase deployment has now published **API v83, worker v118 and
source-browser v1**; all deployed reachable files match the canonical local
source exactly, and health/anonymous-denial checks pass. The lease-scoped
identity migration is live. The browser
workflow now authenticates automatically using GitHub OIDC, with server-side
session encryption. Both new identity tests and seven browser/queue tests pass;
all three frozen Deno entrypoints pass. Final local regression passed **1,221
backend tests in 72 files** and **212 frontend tests in 38 files**, with both
package typechecks/builds. Published index, Knowledge, SourceDetail and
GenerationPanel assets match the local production build. Hosted queue
acceptance remains in progress. The first replacement proposal review succeeded;
the other two reviews are still executing, with all saved draft steps retained.
The canonical CLI deployment script and manual deployment workflow both include
the browser gateway; the backend README records its OIDC and human-answer flow.
The first OIDC workflow spent ten minutes in dependency/browser setup, while the earlier
attempt completed that step in 35 seconds. The workflow now uses Google Chrome
already supplied by the GitHub-hosted runner, avoiding a repeated OS install;
the local default remains Playwright's installed Chromium. A fresh hosted run
will verify the identity and queue path.
That first run subsequently reached the gateway but returned HTTP 401. Safe
diagnostics now expose only public identity claims and expiry times on rejection,
never the signed token; hosted OIDC acceptance remains open until corrected.
Safe readback isolated GitHub's new immutable subject format:
`repo:salahassi@1439837/tenders@1418689096:ref:refs/heads/main`. The verifier now
accepts that exact subject and the legacy spelling, while still requiring the
signed issuer, audience, repository, ref and workflow. A regression accepts the
actual immutable subject and rejects other owner/repository IDs.

Hosted identity/browser admission now passes:
[workflow 39805449018](https://github.com/salahassi/tenders/actions/runs/39805449018)
completed successfully in 22 seconds at **15:30:45 UTC**, using the runner's real
Chrome and **source-browser v2**. Its deployed reachable files match canonical
source exactly. The successful claim returned no pending browser request, so
this proves startup, signed identity and authorized queue access, not rendered
production ingestion or a human-entered CAPTCHA. The earlier six-notice Etimad
render remains the separate real public-page test. Approved Ministry jobs retain
their saved model continuations; no proposed source was silently activated.

The Owner also asked how to delete a note. Added an explicit Delete action and
confirmation to Additional notes. It uses the existing revision-checked
`knowledge.save` command to disable the selected note, then filters disabled notes
from the active list. The original row and saved proposal history remain; no real
note was deleted during implementation. A focused UI test verifies the selected
ID, current server revision, confirmation and disabled status.

## October 22 — Live source diagnostics and MDLF hostname recovery

Owner requested database inspection and real collection tests. The live directory
contains 35 external sources: 17 approved and 18 proposed. Before this test, four
approved sources were healthy, eleven blocked and two unavailable. The list's
Enabled badge reflects approval and does not display collection health.

Fetched every external source URL with TLS verification. Replayed the saved
production extraction code on fresh responses: An-Najah returned 18 notices,
Ramallah 10, Jordan GTD 7 and IsDB zero (closed notices excluded). Live jobs show
supplier/central-referral pages blocked as non-listings, Etimad browser/access
restrictions, Amman model evidence-validation failure and Aramco navigation limits.
These are distinct from the eighteen sources that have never been enabled.

The configured MDLF www hostname failed TLS verification through the execution
proxy. The official HTTPS apex hostname returned the actual announcements page.
Corrected the catalog and, through revision-checked audited source commands,
updated only the selected existing workspace's MDLF URL/host, preserved its
automatic reader configuration and resumed collection. The superseded retry job
was canceled with a reason. New MDLF job: `55c31041-e19f-4f3e-a3d8-2467db3c2181`.
Fifteen other approved sources received fresh collection jobs; SAMA retained its
existing automatic retry. No proposed source was activated.

Implementation: source reference correction complete. Local verification:
backend typecheck/test/build passed (1,207 tests in 70 files); frontend frozen
install and typecheck/test/build passed (208 tests in 36 files); diff checks passed.
Deployment: live source configuration saved and read back; no API/worker code or
schema change and no redeployment required. Repository publication is not part
of this diagnostic request.

Hosted acceptance remains separate: MDLF job `55c31041-e19f-4f3e-a3d8-2467db3c2181`
succeeded and its source is healthy; other fresh jobs are queued or resuming
saved model results. The fresh MOF request
blocked with numeric error `20`: the automatic reader currently propagates an
AbortError's numeric code instead of a useful timeout classification. The initial
35-URL probe returned 28 HTTP 200, two HTTP 403, four HTTP 503 and one connection
timeout; a bounded retry retrieved PIF successfully. The MDLF HTTPS apex retry
also succeeded. SAMA still fails TLS verification. Direct saved-parser results
above are fresh-response tests, not a claim that every newly queued job succeeded.

## October 22 — 40,000-token ceilings and bounded hierarchical planning

Owner-authorized implementation. All task defaults and the settings
editor use a 40,000 output ceiling, subject to actual provider capability limits.
A pinned economy policy tells new operations to stop once their complete result
is expressed; the allowance is not a target length. Existing accepted requests
retain their profile and prompt. New proposal workflow 3 separates a compact
requirement ownership/shared-decision structure from subject-scoped detail jobs.
Exact original evidence remains available to writers and verification. Detail
truncation subdivides only that group, without repeating completed groups. New
graphs reserve separate generation (3) and content-correction (2) allowances,
with a combined ceiling of 5 received writer results; old budgets are immutable.

Hosted evidence before this release: the workflow-2 trial completed all three
analysis parts but blocked during planning. Two responses truncated at the old
16,384 ceiling, then a third candidate failed an exact evidence-quote check.
No correction was sent because all three shared writer allowances had been used.
There is no completed real Word or proven throughput improvement yet.

Implementation and local verification passed: **1,147 backend tests in 67 files**
and **205 frontend tests in 36 files**; both packages typecheck/build and both
Edge entrypoints pass frozen Deno checking. Tests cover complete ownership,
immutable shared decisions, splitting/merging saved detail groups, truncation
without an unchanged failover POST, separate correction allowances, crash replay,
legacy prompt identities and safe planning-only recovery with changed-evidence
rejection. The local no-template/no-company-data journey reaches an export
snapshot; it is not proof of a successful real provider-generated Word.

Published migration `bounded_hierarchical_planning` (canonical SQL SHA-256
`d46b69d0ecd24bccfe7e1096e49398b0879edc2c26ced06c9530136c9948beef`), API **v80** and
worker **v104** on October 22 at 07:42 UTC. Retrieved deployed source files match
the canonical bundles; Supabase omits `deno.lock` from retrieval. Security
advisories remain the pre-existing private-table policy / authenticated RPC /
Auth password-protection categories; the new recovery RPC is service-only.

The existing real trial was safely upgraded at 07:42 UTC after confirming its
proposal inputs are unchanged. All three completed analysis steps and paid
receipts remain intact; only failed planning was superseded. Broad workflow-3
admission remains restricted to that trial until live acceptance.

Hosted follow-up exposed a JSONB object-order comparison in verification
partition recovery: identical fields were rejected after a worker restart. Worker
**v105** compares exact policy fields/values independently of key order, rejecting
changed values and unknown fields. The 66 focused tests include real graph
restarts with reordered policy objects, unchanged paid receipts and one writer
POST. Both Deno and backend build/typecheck pass; **1,150 backend tests in 67 files**
pass after this correction. Frontend code is unchanged from the verified
205-test release.
The original saved writer and first verification batch were reused through the
browser's audited single-job retry; no prompt or accepted result was replaced.

At **07:58 UTC**, the real structure passed grounding and ownership validation:
**18 sections, 13 shared decisions, 122 unique requirements assigned once**.
Planning advanced automatically to **8 detail groups**. Three settled model
requests used **84,029 input / 14,241 output tokens** (1,034 separately reported
thinking tokens may be included in output). The structure writer itself used
8,183 output tokens under the 40,000 ceiling; the two Gemini verification
responses used 2,426 and 3,632. No truncation occurred. Detail completion,
writing, final review and real Word export are still pending; this is not a
completed end-to-end latency benchmark.

Source release `44df45a` passed the hosted Pages build and deployment:
[workflow 39742515678](https://github.com/salahassi/tenders/actions/runs/39742515678).

At **08:09 UTC**, all eight detail groups passed and merged without omitted or
multiply owned requirements. The plan advanced to **54 writing units**. This
is a completed planning gate, not completed drafting or a fair like-for-like
latency comparison with the older 145-requirement/67-unit plan.

The live queue initially preferred untouched writing siblings over ready
verification continuations because their due time was older. Migration
`prioritize_proposal_continuations` deployed at **08:17 UTC** finishes a saved
proposal unit before a fresh sibling *within the same owner*. Class/owner
fairness, accepted-request deadlines, capacity, due times and exclusive leases
remain unchanged. Six local queue tests pass, including continuation precedence,
other-owner and collection service, delayed eligibility and capacity guards.
This lets content feedback arrive before paying for all remaining writers.
Full backend regression now passes **1,152 tests in 67 files**, with backend
typecheck/build. The first full run hit the existing 30-second fixture setup
timeout in one suite (1,151 tests passed); rerunning with the CI worker setting
passed all suites. No timeout or assertion was weakened. Frontend remains at
205 passing tests with no further frontend change.

At **08:32 UTC**, 12 of 54 real writing units have completed grounding and
validation. Every observed planning/writing/verification/repair attempt records
a 40,000 output ceiling. Invalid verification results and two content repairs
were handled within the existing bounded graph; no job is currently failed or
blocked. Final review and the actual Word download remain pending.

Worker source `d192151` passed
[CI and Pages 39744554596](https://github.com/salahassi/tenders/actions/runs/39744554596).

Queue release `b018678` passed
[CI and Pages 39748699807](https://github.com/salahassi/tenders/actions/runs/39748699807).

The live trial reached 30 completed writing units at **09:01 UTC**. A later
numeric guard false positive was isolated: a numeral inside a known proposal
unit key was treated as an unsupported contractual quantity by three verifier
attempts. The guard now exempts exact section/decision keys only from the frozen
server-built proposal context, at full identifier boundaries. Unknown keys,
prefix/suffix lookalikes and surrounding amounts/durations remain checked. All
normal, scoped, aggregate and retained-report recovery paths receive the same
context; candidates cannot create their own exemption list. **149 focused tests**
pass, including a real graph restart/aggregate-acceptance case and unknown-key,
boundary, Arabic-number, price and duration rejection cases. Backend typecheck,
build and frozen Deno worker checking pass. Worker **v106** was deployed at
**09:05 UTC**; all 50 retrievable files match the canonical bundle. API remains
v80. Source `9700037` passed
[CI and Pages 39752916060](https://github.com/salahassi/tenders/actions/runs/39752916060),
including **1,164 backend tests / 67 files** and **205 frontend tests / 36 files**,
both package typechecks/builds and both Edge checks. No paid receipt, prompt,
budget or accepted content is replaced.

The final scoped verification result now merges/commits within the same lease
when at least ten seconds remain, including content-only verification without a
separate requirement pass. Previously that last content batch always yielded,
adding a queue cycle even though only local work remained. Intermediate batches
still yield before another provider request. **58 model execution integration
tests** pass, including sufficient/insufficient remaining-time cases with complete
content coverage, one writer call, immutable receipts and crash/restart replay.
Backend typecheck/build and frozen worker checking pass. Worker **v107** deployed
at **09:32 UTC** and all retrievable files match the canonical bundle. Full CI
of this small scheduling follow-up is pending. This removes a specific handoff,
not all provider/queue latency in the live trial.

All **54 primary writing units** completed at **09:34 UTC**, advancing to two
commercial groups. One group completed; the other reached a verifier correction
limit at **09:49 UTC**. Inspection isolated a deterministic row-label guard bug:
`BOQ item 2` was recognized but `BOQ 2` was incorrectly treated as a quantity.
The guard now accepts either spelling only when the referenced quotation maps
to that actual table/list row. Wrong row labels and unrelated quantities remain
rejected. Local revalidation of the unchanged retained real scope passes all
**36 claims**, with no defects and no provider call. The customer evidence and
offline diagnostic remain outside the repository. **135 focused tests** pass,
with backend typecheck/build and frozen worker checking. Worker **v108** deployed
at **09:55 UTC**, with exact source readback. Full CI, audited recovery and the
real export are being completed.

The first audited retry exposed a separate recovery restriction: only
`draft_section` could reopen an exhausted *scoped* verifier after its retained
report passed corrected deterministic checks. The same recovery now validates
the candidate against its actual primary task schema. The DB permits other
tasks only for an exact `revalidated_scope` artifact; invalid reports still
cannot trigger a new writer-repair path outside the existing draft behavior.
Lease/manifest/identity checks, unique latest report, unknown-send protections,
candidate budgets and original receipts remain intact. Canonical migration
`generic_revalidated_scope_recovery` deployed at **10:03 UTC**. **60 focused
tests** pass, including commercial whole/scoped graph replay with zero provider
calls and SQL rejection of a non-draft repair-only artifact. Backend typecheck,
build and frozen worker checking pass. Worker **v109** deployed at **10:04 UTC**;
all retrieved files match the canonical bundle. Full CI and hosted recovery are
completed with zero new provider calls for the revalidated scope. Source
`b8f1d65` passed [CI 39760336153](https://github.com/salahassi/tenders/actions/runs/39760336153).
Earlier releases `b4a0e21` and `15a8aab` passed
[39756315707](https://github.com/salahassi/tenders/actions/runs/39756315707) and
[39759204923](https://github.com/salahassi/tenders/actions/runs/39759204923), respectively.

At **10:14 UTC**, commercial verification encountered PostgreSQL SQLSTATE
`57014` (statement timeout), incorrectly exposed as permanent
`DATABASE_COMMAND_FAILED`. Transaction-aborted timeouts, lock failures,
deadlocks and serialization failures now map to a sanitized transient code and
the existing automatic backoff policy. Permission/schema/constraint/ambiguous
errors stay non-retryable. Recovery retains graph results, budgets and queue
checkpoints; it does not reclassify older errors without evidence. Current
notification-query profiling returned 38 rows in 24 ms, so no unproven query or
timeout-limit change is included. **61 focused tests** pass, including a real
SQL job failure/reclaim with unchanged stored results/budgets, backoff and stale
lease rejection. Backend typecheck/build and both frozen Edge checks pass.
Migration `transient_database_recovery`, worker **v110** and API **v81** deployed
at **10:26 UTC**; all retrievable source files match their canonical bundles.
Source `5552f6c` passed [CI/Pages 39763127737](https://github.com/salahassi/tenders/actions/runs/39763127737):
**1,186 backend tests / 68 files**, **205 frontend tests / 36 files**, both
typechecks/builds and frozen Edge checks. The browser's audited retry completed
commercial work at **10:29 UTC**, then synthesis completed at **10:30 UTC**.
All **55 writing units** and both commercial groups are saved. Six coherent
review groups are running; final reconciliation and real Word export remain
pending. The result is not yet a finished document or latency acceptance.

Live review inspection found a scope ambiguity: a reviewer could interpret its
filtered commercial lines as the entire BOQ. New workflow-3 review inputs now
pin an explicit scope marker. Scoped reviews receive available/included counts
and the complete line-to-requirement ID index; final reconciliation receives
every completed commercial line, task and question even with no assigned IDs.
Generated commercial data remains unconfirmed proposal content, never evidence.
Unmarked requests retain their exact projection, so in-flight paid work is not
rewritten. **49 focused tests** pass, including old projection replay, scoped
metadata, complete final commercial coverage/dependencies/questions and preserved
source authorization. Backend typecheck/build and frozen worker checking pass.
Worker **v111** deployed at **10:43 UTC** after a transient Supabase deployment
error; the prior version remained active until the successful replacement.
Full CI and final live reconciliation remain pending.

At **10:49 UTC** a review reached its correction limit because a finding named
a real hosting section outside its prose group. Findings may now name a known
frozen response location when they also touch a reviewed section; fulfillment
responses still require the supplied prose and invented references are rejected.
A locally rejected retained writer can be revalidated after this guard correction
and resumed at independent verification. The transition checks its immutable paid
receipt, candidate lineage, manifest, current lease and absence of unknown/pending
sends. It changes no budget, candidate or prior verification verdict. **49
focused tests** pass, including three paid writer receipts preserved through
exhaustion, one independent verifier after guard correction, and replay after
an interrupted recovery checkpoint. Backend typecheck/build and frozen worker
checking pass. Migration `revalidate_retained_writer` and worker **v112** deployed
at **11:02 UTC**. Full CI and the real final export remain pending.

The commercial review also exposed an application-policy ambiguity: grounding
treated valid negative audit outcomes as faults in the audit itself, including
missing implementation/test evidence for proposed future delivery. Newly pinned
review verification uses policy v3: assess the audit's accuracy against supplied
prose, keep real business gaps in the audit, and reserve verification blockers
for errors in that audit. Existing phase pins remain exact. No report is accepted
by filtering away model findings; old blocked results require an explicit,
bounded fresh verification under the corrected policy. **116 focused tests**
pass: the real graph preserves blocking business findings, resumes exactly one
audit recheck after a crash, and retains every writer receipt/budget. Backend
typecheck/build and frozen worker checking pass. Migration
`review_verification_boundary_recheck` and worker **v113** deployed at **11:14 UTC**.
Full CI for v112 caught one outdated diagnostic-path assertion (the guard now
reports the exact offending field); it is updated in this release. Hosted audit
recovery, final reconciliation and Word download remain in progress.

Further read-only replay isolated the remaining retained review rejection to a
`partial` response, not its findings: it names actual reviewed security sections
and a real hosting section that explicitly still needs verification. Unresolved
responses may now retain those known cross-section follow-ups, anchored to a
reviewed section. `answered` still requires supplied prose; invented keys and
entirely outside-scope responses remain rejected. The existing lease-bound
retained-writer recovery performs independent verification without rewriting
the result or resetting budgets. **58 focused tests**, backend typecheck/build
and frozen worker checking pass. Exact private replay of the retained real
candidate now passes schema, original-evidence and section-reference validation.
Worker **v114** deployed at **11:27 UTC**; hosted recovery remains pending.
Full CI for source `25151cb` passed, including both package suites,
typechecks, builds and Deno checks.

The remaining audit exposed missing provenance for the draft itself: a verifier
could read the proposed prose but had no valid source ID for observations about
that prose. Newly versioned reviews move the unchanged saved prose/commercial
projection into one citable, explicitly unconfirmed review snapshot. It proves
wording only; company-fact checks still require verified company evidence. The
original authorization manifest is preserved and the full prose is not copied
twice into the prompt. Existing requests retain their exact inputs. An explicit
Owner/service-only recovery replaces only an exhausted legacy review with the
new context, preserving completed steps, paid usage, graph budgets and all old
results; pending/unknown sends, stale revisions/evidence and repeated recovery
are rejected. **54 focused tests** pass, including original request replay,
single-copy prose, rejected company-claim promotion, fabricated quote rejection,
safe review replacement, preserved paid receipts/budgets and service-only access.
Backend typecheck/build and frozen worker checking pass. Worker **v115** and
`citable_review_context_recovery` deployed at **11:35 UTC**; hosted application
of the recovery and final Word acceptance remain pending. Source `3bffc2b`
passed full CI and publication; v114 readback matched all 51 retrieved files.

Hosted follow-up: both replacement reviews completed and all six scoped groups
advanced automatically to final reconciliation. Its first verification exposed a
numeric-guard false positive: digits inside the exact supplied
`proposal-review:<uuid>` source ID were treated as business quantities. The guard
now recognizes exact supplied namespaced UUIDs while retaining checks on unknown
IDs, embedded IDs and neighboring prices/quantities. No citation text, finding or
model budget is changed. **143 focused tests**, backend typecheck/build and frozen
worker checking pass. Private replay of the unchanged actual final report now
passes all 23 claims with zero verification defects. Worker **v116** deployed;
hosted commit/export remains pending. Source `3c3587f`
passed full CI: **1,200 backend + 205 frontend tests**, typechecks/builds and Deno.

At **12:05 UTC**, the real plan completed and saved proposal version 1 with
**56 sections**, including the generated compliance matrix, and separate
technical/financial volumes. All 122 requirements remain represented. Final
assembly recovered automatically from a transient database timeout without a
new model request. Source `66e66ff` passed
[CI/Pages 39774428676](https://github.com/salahassi/tenders/actions/runs/39774428676):
**1,204 backend + 205 frontend tests**, both typechecks/builds and Deno checks.
All 52 retrieved worker-v116 files match source. This establishes saved draft
completion; actual export acceptance is recorded separately below.

Hosted browser acceptance then exposed overlapping completion refreshes: the
ten-second progress poll could start another full workspace refresh before its
predecessor finished. The old response was rejected as superseded, the completion
marker was never recorded, and later polls repeated the work. Progress requests
now serialize through the full completion refresh and ignore results after
navigation/unmount. A failed refresh stays retryable on the next poll. No polling
interval, authorization, model request or existing saved content is changed.
All **6 progress-panel tests** and frontend typecheck pass, including a 40-second
delayed refresh, failure recovery and navigation while a request is outstanding.
Full frontend checks, publication and hosted verification of this UI correction
are pending. Database statement timeouts were also observed during the first
export attempt; their complete underlying cause is not established by this fix.

The second actual browser export succeeded for both volumes. Server verification,
download hashes and DOCX ZIP/XML checks passed; no model calls were made for the
export. LibreOffice rendering exposed **187 technical / 40 financial pages**.
Inspection found two deterministic assembly defects: distinct blueprint unit
titles made the legacy outline reader discard the 18 logical chapters, and the
generated compliance matrix was followed by another export-generated matrix.

New outlines pin each unit's original title and explicitly mark application-built
matrices. Export retains chapters and subsection titles, projects one matrix from
the current frozen review/compliance data, and partitions its rows by volume.
Model suggestions remain unconfirmed; original business findings and unknown
prices are retained. Older frozen export requests retain their original rendering.
Unknown/changed titles, volumes or lineage fall back without dropping sections.
The same real saved 56 sections validate against their original planning/writing
lineage with **18 groups**; the corrected export accounts for **115 technical + 7
commercial requirements** once. It does not regenerate or rewrite prose.
**45 focused export/outline/blueprint tests** pass. Frontend full rerun passed
**208 tests / 36 files**, typecheck and build; its first run under concurrent
browser/rendering load hit an unrelated Sources-navigation wait failure, with
207 passing tests. No assertion or timeout was relaxed. Backend full checks,
runtime publication and corrected hosted downloads are pending.

Export follow-up deployed as **API v82 / worker v117**. Backend typecheck/build
and both frozen Deno entry checks pass. The 31-test generation integration suite
also passes after updating its old duplicate-matrix header assertion to require
one matrix covering every requirement. An audited, revision-checked update to
the completed trial draft pins only the display outline: original lineage,
56 unchanged section rows, original titles/volumes and draft status were verified.
The version revision advanced from 1 to 2; saved prose, model receipts and older
immutable export snapshots are unchanged. No additional model generation was
requested. Corrected real downloads and complete CI are pending.

**Final functional acceptance, October 22:** source
`c0ed85d954aa62367c388428c7fb8bb82da12e90` passed
[CI/Pages 39779723403](https://github.com/salahassi/tenders/actions/runs/39779723403),
including **1,207 backend tests / 70 files and 208 frontend tests / 36 files**,
both typechecks/builds and frozen Edge checks. API v82's 34 retrieved files and
worker v117's 52 retrieved files match the submitted bundles exactly. The earlier
local full backend run passed 1,206 tests and failed only the superseded matrix
header assertion; the corrected generation suite and full CI passed.

A fresh authenticated Chromium session loaded the published bundle, downloaded
both corrected actual Word files, and remained free of console/page and visible
alert errors through 90 seconds of subsequent polling. Initial reused browser
profiles closed while saving downloads; those attempts are not counted as passed.
Both final files passed server content verification, local ZIP/XML checks and
LibreOffice rendering. Actual DOCX matrices contain **115 technical and 7
commercial rows**, matching the original 122 requirements exactly once. The
technical document rendered as **131 pages** (previously 187); the financial
document has **42 pages**, now including its seven commercial matrix rows.
Sampled cover, contents, narrative, table and closing pages are readable. These
page counts depend on the renderer and are not required document lengths.

The real draft is complete and editable, **not approved for submission**. It still
has unknown pricing, team/project proof and execution inputs, and review findings
about conflicting delivery dependencies. There are 426 saved questions; simplifying
and consolidating their presentation remains an editorial/UX issue. The draft
includes review material and is still long. Word fields/contents require refresh
in the editor. No missing fact was filled by invention and no business approval
was granted to make export pass.

From the 07:42 planning recovery to completion around 12:05, this diagnostic run
used **236 settled requests, 6,683,953 input / 865,474 output tokens**, with 71,058
separately reported thinking tokens that may already be included in output. These
figures include debugging/recovery; they are not a healthy-run benchmark or
equivalent comparison with the older 145-requirement plan. No new model request
occurred after completion during assembly/export corrections. The 50% request
reduction and end-to-end latency targets are **not established**.

After both current-outline exports passed, an audited configuration update enabled
workflow 3 for new proposal admissions. It does not enqueue generation or change
saved in-flight work. This is functional rollout, not closure of the outstanding
performance/editorial acceptance goals in PROPOSAL_PERFORMANCE_PLAN.md. The
completed trial and older export snapshots remain available; no customer documents
or credentials were added to the repository. This reconciliation changes docs only.


## October 21 — approved throughput and coherence follow-up

The Owner reviewed the plan and explicitly authorized implementation.
[PROPOSAL_PERFORMANCE_PLAN.md](PROPOSAL_PERFORMANCE_PLAN.md) extends P3/P4/P5/P6
of the original model execution plan with fair queue scheduling, semantic work
units, shared solution decisions and scoped verification/repair. It records
measurable acceptance gates and versioned rollout. Status: the queue and versioned
workflow are deployed; controlled real-file acceptance remains in progress.
The already-running proposal retains its saved path. This does not revert the
previously deployed two-request concurrency setting or general-section fix.

Implemented for this release: durable weighted class/owner scheduling, eligibility
and model-capacity admission, and up to three local transitions per invocation
with a time budget. Local assembly can wake at full inference capacity. The new
proposal workflow was installed with admission disabled and is now restricted
to one real trial opportunity: a strict blueprint gives
each requirement one primary response, records shared labeled decisions and
semantic writing units, writes the executive summary after the main sections,
packs review around full sections, and adds cross-section reconciliation. The
application builds the compliance matrix from actual review responses and
deduplicates identical questions. Version 1 inputs, routes, partitions and paid
work remain unchanged. Configured planning routes also serve the new blueprint.

Verification partition sizes for version 2 derive from the frozen task output
profile. Every content unit, including undeclared claims, remains in the review;
an empty requirement-only pass is omitted only when no requirement IDs are
assigned. Versioned cache identities and the existing bounded LangGraph repair
allowances are retained. This is not a cross-job semantic claim cache.

Local evidence: **1,134 backend tests in 66 files pass**, including actual
PostgreSQL queue fairness/capacity/dependency tests and a canonical semantic
generation-to-export-snapshot journey with no company evidence or custom
template. The separate generation integration suite passes **27/27**. Both
entrypoints pass frozen Deno checking. Backend typecheck/build and frontend
typecheck/build pass; **205 frontend tests in 36 files pass**. The last focused
run also covers compact, reversible requirement references: UUIDs remain in
business records while the planner receives short stable labels. Deployment is
recorded below. The first full queue regression found four expectations
around capacity and collection/detail ordering; capacity coverage now checks
both queue admission and the reservation defense, while collection/detail
ordering remains fair within the background class. No hosted success is inferred
from these synthetic fixtures.

Remaining gates: controlled real new-version acceptance, actual downloadable
files and measured submission/timing savings.
The plan's broader cross-job claim receipts, automatic passage-only editorial
repair and hierarchical planning for inputs beyond one blueprint's context
remain follow-up work; the existing per-result bounded repair still applies.

Release `24470bc98bfb74461242e6f5215cacf93b5e4205` passed
[CI and Pages 39688504933](https://github.com/salahassi/tenders/actions/runs/39688504933).
Hosted migrations are `20261021224317` / `20261021224326`; API v79 and worker
v103 are ACTIVE. All 33/48 returned runtime files match the prepared sources.
Health returns 200, anonymous bootstrap 401, the local claim RPC is service-only,
and advisor categories/counts are unchanged. The old plan remains version 1 and
has reached review after completing drafting/commercial. Version 2 admission is
restricted to the authorized real-RFP test copy. The original record/file is
unchanged; author metadata is removed only from the test PDF, with all 21 pages'
extracted text verified equal. Browser acceptance exposed an overlapping inline
review label that prevented clicking its checkbox; the label now uses block
layout. Release `639e4d9fb074d54625028a4efc3a1aad923def70` passed
[CI and Pages 39689903896](https://github.com/salahassi/tenders/actions/runs/39689903896);
the published CSS matches the locally tested build byte-for-byte. The local
205-test frontend suite, typecheck and build also pass after this correction.

Controlled hosted trial: opportunity `848a1a8f-089b-4157-92ab-0955049a2ca2`,
plan `abd09c60-ac20-4250-b0fb-6b0c59ff38b1`, workflow 2. Browser upload,
extraction review and Generate each reached successful server commands. The
31,636-character extracted text equals the previously reviewed RFP text exactly.
Owner-authorized OpenAI/Gemini content permissions were recorded through the
canonical audited commands for the copy. A pre-permission analysis job was
resumed individually after permission was recorded; whole-plan resume correctly
refused to reset work while a request was reserved. No paid work/budget was reset.
At 23:05 UTC one OpenAI analysis response succeeded (4,415 input / 9,668 output
tokens); another accepted analysis request remained pending. This is provider
response evidence, not completed analysis/verification or a completed proposal.
The original version-1 plan still has 67/67 drafts and 3/3 commercial tasks done,
with 2/13 review tasks committed. Both continue on the normal automatic queue.
No new real Word download or measured 50% saving is claimed yet; general version-2
admission remains off pending that acceptance gate.

## October 21 — bounded parallel background model requests

The owner asked about parallel workers during the real proposal run. Its one
workspace-wide accepted request slot let background assessment hold up proposal
verification. A configurable limit of 1–4 task-routed model requests is now
available, with serial behavior retained until configured. Worker leases remain
serialized. Reservations keep the workspace lock, same-job exclusion, frozen
request identity, unknown-usage guards and paid-call budgets. Accepted requests
remain pollable when the limit is reduced. Owner-only audited settings expose
the limit in Models & providers. Live activation and acceptance are recorded below.

Local verification: the complete backend run covered 1,117 tests; 1,116 passed
and one new wake test exposed nondeterministic fixture ordering between two due
polls. After making the unrelated fixture poll future-due, its complete 72-test
file passes. The new admission test covers two distinct accepted jobs, rejection
of a third and a duplicate on the same job, and resumption after reducing the
limit without rewriting usage. Both package typechecks/builds and frozen Deno
entrypoints pass. The complete frontend run passed 202/205 tests; three existing
UI journey tests timed out under concurrent backend load. The connected-screen
file then passed 25/25; the app journey file still timed out alongside the DB
tests, then passed 19/19 in isolation without changing its code or assertions.
The new settings component suite passes 7/7. CI, deployment, real two-request
overlap and actual Word export remain pending. Generated OpenAPI was refreshed
from the canonical command schemas, including previously undocumented commands.

Release `c3415f1f302e16aca861ba31bb39d0a6f1b3d182` passed the complete
[CI and Pages workflow 39676627548](https://github.com/salahassi/tenders/actions/runs/39676627548),
including both full test suites, typechecks, Deno and frontend build. Hosted
migration version is `20261021211205`. API v78 and worker v102 are ACTIVE;
all 31 and 46 returned runtime files respectively match the prepared sources.
Security/performance advisory categories and counts are unchanged. The private
limit helper is not executable by anon, authenticated or service_role.

At **21:16:03 UTC**, the existing audited Owner command changed the limit from
one to two (settings revision 1 → 2), preserving routing admission time and all
existing requests. At **21:16:59 UTC**, actual accepted OpenAI requests overlapped:
the retained background assessment on `gpt-6-luna` and proposal drafting on
`gpt-6.1-sol`, with distinct jobs/request IDs. Later samples also show OpenAI and
Gemini overlap, no more than two reservations and at most one worker lease.
This demonstrates concurrent provider work; it does not claim parallel database
worker leases or a completed proposal. The real plan was still drafting 62/67
at the initial activation check.

Authenticated hosted Chromium acceptance at 1440px and 390px confirms the saved
limit of two is visible, read-only for the existing Editor account, with no
horizontal overflow. The settings card was visually inspected at both sizes.
An initial exact accessible-label locator included the select options and timed
out; scoping the select to its section fixed the QA harness without application
changes. Owner mutation is evidenced by the audited command and integration
tests, not by an Owner browser session. At 21:30 UTC, the existing proposal had
completed 66/67 drafting parts; full Word acceptance remains separate.

## October 21 — general section context correction

Real-content inspection found that the retained executive summary incorrectly
said no RFP was supplied. Its template section had no mapped requirement IDs;
company evidence prevented the old empty-evidence notice fallback, leaving the
writer without the attached RFP. Newly planned general sections now explicitly
request all frozen RFP blocks as context, without inventing assigned requirement
IDs or company credentials. Existing paid prompt identities remain unchanged.
A restricted, revision-checked recovery replaces only an unpublished completed
general section's job. The previous paid output is archived on its original job;
usage, graph budgets, the section ID and its outline position are retained.
The complete backend regression passes **1108/1108 tests in 64 files**, including
ten PostgreSQL recovery and scheduling checks. The fixture's missing required
evidence revision was corrected before its successful rerun. Backend
build/typecheck and the Deno worker check pass. Evidence is recorded in
`/workspace/work/proposal-unmapped-context-full-backend.log`. Deployment and actual
replacement acceptance remain pending. The other drafting parts continue.

Worker v101 is deployed with all 46 returned source files matching the prepared
release; the deployment consumed the supplied Deno lockfile. Two preceding build
attempts failed because npm advertised `@langchain/langgraph-sdk@1.12.6` while its
tarball returned HTTP 404. The checked/tested `1.12.5` tarball returns HTTP 200.
The committed Deno lockfile and frozen configuration now preserve the tested
dependency tree; both Deno entrypoints pass with that lock. CI checks also honor
the lock instead of bypassing it. Migration `unmapped_draft_rfp_context` is
deployed. Only the old executive-summary job is replaced; all other paid work is
retained and the complete Word journey remains in progress.

Hosted content acceptance at **21:39 UTC** confirms the replacement executive
summary completed through the normal writer and verifier path. It names the
actual buyer/project and describes the supplied scope, schedule, hosting and
governance requirements. The prior assertion that no RFP was supplied is no
longer present. All 67 drafting parts are now complete;
commercial planning, final review, assembly and real download remain pending.

The owner's partitioning question also exposed a performance/quality limit:
planning maps requirements to one or more sections, then drafting uses a fixed
eight-requirement group size. This plan has 17 logical chapters and 67 parts.
Writers receive their mapped requirements and evidence but no shared solution
decision ledger or other drafted prose. Batch review checks overlapping sections
for its requirements; it is not a complete editorial coherence pass. A semantic
outline, primary requirement ownership, shared decisions and scoped consistency
review remain improvements; no current paid parts were regenerated to test them.

## October 21 — resumed real proposal acceptance

The owner requested a complete proposal after setup validation. The existing
uploaded RFP, confirmed extraction and authenticated Editor session are intact.
Plan `bb7d25ed-ed18-49b2-886b-3be5a54bbd2c` remains canceled at revision 151,
with analysis 3/3, planning 9/9 and drafting 40/67 complete. Task routing is
enabled; OpenAI and Gemini routes, background transport and the once-per-minute
scheduler are configured. No plan was restarted or new model request made during
the setup checks. The baseline is 257 usage records, 2,336,988 reported input and
1,079,403 reported output tokens, including four historical unknown Gemini usages.

The full backend run covered 1,096 tests: 1,088 passed and eight failed because
two test files still expected the old migration list and callback signature.
Only those assertions were updated; both complete files then passed 77/77 tests.
Evidence: `/workspace/work/proposal-resume-backend-tests.log` and
`/workspace/work/proposal-resume-corrected-tests.log`. Both packages pass
typecheck/build; both Deno entrypoints pass. Frontend runtime code is unchanged
from its previously verified 204-test suite. The two pending migrations and
runtime release are ready for deployment; real resume/download acceptance is
still pending and must not be inferred from fixture tests.

At 18:35 UTC, both migrations are deployed (hosted versions 20261021183405 and
20261021183418). API v77 and worker v100 match all 31 and 46 reachable source
files respectively from commit `993898b`. Private recovery helpers remain
unavailable for direct anon/authenticated/service-role execution. The ordinary
browser resume initially met a transient workspace usage reservation; after it
cleared, HTTP 200 resumed the same plan at revision 152 at 18:36 UTC. At 18:43 UTC,
drafting is 42/67 complete with no current blocker. One previously blocked task
has completed its actual bounded writer repair and independent verification.
Six new calls report 71,292 input / 16,435 output tokens with no new unknown usage.
The cloud test environment restarted during this interval; Supabase processing
continued and the local checkout has been recovered. Complete Word acceptance
remains pending.

## October 21 — real acceptance blockers (in progress)

The next correction release is implemented locally and independently reviewed.
Safe, schema-valid V1 writer content errors now retain the paid candidate and
precise bounded validation paths, then enter normal LangGraph repair rather than
trying the unchanged prompt on another provider. The exact handoff preserves
failure telemetry, candidate budgets, pending-request identities and current data
permissions, including crash replay. Repaired output still requires complete
independent verification; repair-only findings cannot grant acceptance.

Historical exhausted verifier recovery now distinguishes a latest retained report
that passes a corrected deterministic guard from a report that still has an
unresolved citation defect. The first resumes the exact saved verification scope
with zero model calls; the second preserves all latest findings as untrusted
repair hints and uses the remaining writer allowance. Decimal section labels
such as `4.2` are no longer split into unrelated integer fragments. Later
corrective reports cannot be replaced by older favorable reports.

Focused verification passed **217 tests**, **38 canonical PostgreSQL/LangGraph
writer-handoff tests**, and **19 unit / 24 canonical verifier-recovery tests**;
backend typecheck/build passed. Main-checkout full regression, Deno checks,
migrations/runtime deployment and real retries remain pending. Immediate content
handoff applies to writer results; verifier requests retain the existing bounded
provider round followed by one report correction. No live result is accepted on
the strength of these synthetic tests.

At 14:52 UTC, live access is restored after the earlier approval-service usage
limit. The original experience job completed at **13:53:16 UTC**: its graph is
committed, exactly one alternate paid-writer selection is recorded, the writer
budget remains **3**, and the new candidate has a separate successful verifier
phase with one candidate. No writer allowance was reset. Analysis remains 3/3
and planning 9/9 accepted; drafting is **36/67 complete**, with only the two
known verifier-validation blockers remaining. A complete Word is still pending.

Frontend verification for this release passed **204/204 tests in 36 files**
(`final-frontend-serial-21.log`, 183.86 seconds) and typecheck. The user's next
acceptance request is explicit: repair the remaining failures, test locally,
then complete the existing real-file journey and download/inspect the proposal.
The separate content-loop follow-up remains isolated and is not included in
the already deployed v99 worker.

At 13:47 UTC, API **v76** and worker **v99** are deployed; hosted readback
matches all **30 / 44 reachable files** exactly. The full backend regression
passed **962/962 tests in 57 files** (`final-backend-serial-20.log`, 373.08
seconds), backend typecheck/build and both Deno entrypoints. These checks cover
code behavior; they are not complete real proposal acceptance.

This release pins a shared semantic instruction revision per model phase.
Paraphrase and translation are allowed while buyer obligations, consequences,
quantities and company evidence retain their meaning. Started, pending and paid
historical phases retain their original prompt identity; the upgrade test proves
one POST followed by a GET rather than a duplicate generation. The separate
follow-up to route safe content-validation failures into targeted LangGraph
correction is still in progress and is not included in worker v99.

The outline migration (`20261021131353_proposal_section_outline.sql`, hosted
version **20261021133536**) preserves all 67 stored parts and derives 17 logical
chapters from their frozen plan lineage. The exporter groups only a complete,
validated outline, retaining every original section and falling back without
dropping content if the outline is invalid. Focused backend and actual DOCX
renderer tests passed; no complete real Word has been exported yet.

The alternate paid-writer migration (`20261021131657_recover_alternate_paid_writer.sql`,
hosted version **20261021134047**) is deployed with service-only recovery access.
The normal authenticated retry for the original experience job returned HTTP 200
and queued revision 62 at approximately 13:52 UTC. The browser's click wait timed
out, but the server response confirms acceptance, so the action was not repeated.
Actual alternate recovery and independent acceptance remain to be observed.

At 13:49 UTC, **26/67 drafting parts** are accepted and three remain blocked;
analysis is 3/3 and planning 9/9 accepted. Since 10:34 UTC the plan has 110 settled
usage records with **1,004,270 input / 315,540 output tokens** and no new unknown
usage. Reasoning tokens may already be included in output. This is measured
usage, not a price estimate; model routing and candidate budgets are unchanged.

Already-paid alternate writer recovery is implemented locally for the corrected
initial company-claim guard. It preserves the original candidate and latest
complete adverse report, selects only a distinct exact settled/count-recorded
initial usage, and requires normal independent verification of the selected
candidate. The private selection chain allows at most two distinct successors;
no writer request, candidate-budget increment/reset, usage settlement or direct
acceptance occurs in recovery. Selection/resume checks retain the current lease,
request identity, provider data permissions and pending/unknown-usage barriers.
Historical pre-JSONB marker hashes remain immutable; selection records the hash
of the persisted candidate separately with exact initial retained-result and
producer provenance. New initial markers use persisted readback hashes.
Focused recovery verification passed **67/67 tests in four files**, including a
real SQL/LangGraph replay with one original GET, one alternate GET and a normal
independent verifier, all three original writer usages/counts unchanged, fourteen
SQL fail-closed cases, crash replay, and second-successor/third/revisit limits.
These are synthetic integration fixtures, not real proposal acceptance. The
`recover_alternate_paid_writer` migration and worker changes were subsequently
deployed as recorded above; actual hosted acceptance remains.

At 13:12 UTC, worker **v98** has exact 40-file hosted readback. Compound
company declarations may be covered by multiple exact candidate quotations;
their union must cover every non-whitespace character, including numbers,
negations and punctuation. All citation and independent semantic checks remain.
Focused guard/recovery tests passed 93 cases plus three SQL/LangGraph replay
variants. Full backend regression `final-backend-serial-19.log` passed **885/885
tests in 52 files** (300.45 seconds), with backend build and Deno worker check.
The real retry added no provider usage but remains blocked: its newest retained
report has substantive mandatory-consequence findings. It must not be replaced
with an older more favorable report. Nineteen of 67 drafting jobs are accepted;
there is still no complete Word file.

Release `0ffa5e4fd00ac812a17b4009f51f76ec517709a9` passed
[CI and Pages 39603349050](https://github.com/salahassi/tenders/actions/runs/39603349050).
After a full browser reload, the real pending proposal route shows **Proposal
preparation**, existing generation state and an Open opportunity link instead of
the previous false 404. The underlying panel still describes the blocked parent
as paused even while independent sibling jobs continue; that copy limitation is
not claimed fixed. The first real `notice.details_unchanged` audit occurred at
12:57:37 UTC. Completed-assessment reuse remains unobserved in production.

At 12:53 UTC, worker **v97** is deployed with an exact 40-file readback. The
legacy outer repair flag no longer hides the paid initial writer request: only
an initial-produce graph without candidate/report references may match the
original recomputed request hash against its exact settled usage, thread and
current provider permissions. Thirty focused tests, including real SQL-store /
LangGraph recovery through independent verification and acceptance, passed.
The real experience job now has its original paid Luna candidate and recovery
provenance saved, with the three writer usages unchanged at 15,582 input / 6,908
output and writer budget 3. Independent verification is still in progress.
Its retained Gemini report exposed another deterministic coverage bug: all 39
content IDs and three requirements are covered, but a compound company claim
was split into two exact adjacent quotations (only whitespace between them).
The current single-quotation coverage check rejects this valid split. A narrow
quote-union correction is being implemented; no recovery acceptance is yet
claimed for this job.

The `preserve_unchanged_notice_details` migration deployed at 12:53 UTC after
43 focused tests and independent review. Of 72 observed detail-refresh
cancellations today, 69 had unchanged evidence except HTTP fetch time/raw HTML
hash. Refresh now preserves an active assessment's paid request, checkpoint,
budgets and saved polling deadline. Automatic reuse requires full normalized
snapshot equality and current permissions for the original providers; it retains
the original assessment result, citations, timestamps and hashes with audited
revision rebinding. Manual reassessment still evaluates. Changed text, dates or
attachment evidence retains canonical evidence/approval invalidation. Equal-text
snapshot selection prefers the current evidence and is deterministically ordered.
Full backend regression `final-backend-serial-18.log` passed **868/868 tests in
52 files** (366.38 seconds), plus backend typecheck/build and Deno worker check.
Real unchanged-refresh audit evidence remains pending.

The pending-proposal UI fix is implemented: an authenticated record lookup shows
existing generation progress while the first version is being created, instead
of a false 404. It creates no editable placeholder or model request; loading,
request errors and real unavailable records remain distinct. Frontend typecheck,
all **199 tests in 35 files** (seven new pending-route regressions), and production
build passed. Five timing failures in an overlapping earlier run passed unchanged
in a serial file rerun and then the complete serial suite. Hosted UI release and
browser validation are pending.

Operations/observability: the Jobs table now preserves the actual worker-attempt
count separately from the current model-routing round, labels creation and update
times explicitly, and explains that worker attempts include result checks and
resumed work. Requesting retry no longer invents an additional execution. Optional
round/update fields preserve existing job-type compatibility; missing timestamps
remain unknown. Local verification passed **28/28 focused tests**, including four
new mapping/UI regressions, then **203/203 frontend tests in 36 files** with one
worker (116.07 seconds), frontend typecheck, production build and diff checks.
The production build retains its existing large-chunk warning. This is a frontend
change only; backend behavior and GenerationPanel are unchanged. Deployment and
authenticated hosted Jobs-screen acceptance remain pending; no new provider
request or live job action was made for these tests.

Hosted acceptance after release `b7301a9`: the actual blocked experience row shows
**Worker attempts 15 · Current model round 2**, Created 13:00 Riyadh and Updated
16:00 Riyadh, matching database values. This read-only browser check clicked no
retry. The browser needed a full reload after the Pages asset replacement; the
old open-tab route first reached the existing reload/error boundary.

Current status at 12:15 UTC: analysis remains 3/3 and planning 9/9 accepted;
**11/67 draft jobs are accepted**, with 53 queued, one running and two blocked.
No complete Word has been downloaded or inspected. Company paraphrase/translation
validation and paid-result recovery were deployed as API v74 / worker v93;
normal worker v95 has the same canonical 40 files. Source
`c1c378afa6348bb58f3c1af03706f015d97abf85` passed
[CI and Pages 39596580459](https://github.com/salahassi/tenders/actions/runs/39596580459).
The authenticated UI retry exposed a separate `USAGE_REVIEW_REQUIRED` bug: the
old per-job action invoked whole-plan retry and refused another job's accepted
pending request. The new targeted retry migration requeues only the selected
blocked/failed current-stage job, preserving sibling work, attempts, candidate
budgets and pending usage. Its focused database tests pass 29/29, including
permissions, idempotency, evidence/revision guards and reserved/unknown usage.

A bounded GET-only diagnostic of the second blocked response returned a
`confidential-` policy match in ordinary paragraph text, with no email or
credential match. It did not establish the character following the hyphen.
Local validation now distinguishes joined word compounds such as
`confidential-information` from explicit classification labels; whitespace or
label punctuation, standalone classifications, secrets and email checks remain.
Model regression tests pass 64/64. A further temporary diagnostic deployment
was rejected by automatic review and was not deployed or retried; verification
will use the ordinary processing path. The live policy cause remains conditional
until normal retry succeeds.

The next queue migration wakes normal work after a canceled job and supports one
bounded wake at the already-saved due time of an exact healthy accepted remote
request. It preserves the 30-second polling interval, current permissions,
revision/lease guards, request identity, normal dispatcher fairness and model
reservation serialization. Another reservation, a potentially active matching
unknown request, or a cron race prevents that optimization. Historical unrelated
unknown telemetry does not block a known accepted request. Focused queue/release
tests pass 110/110 after the scope correction. Full backend regression passed
842/842 in 52 files (262.87 seconds); backend typecheck/build, both Deno entrypoints
and frontend typecheck, 192 tests and build passed. The targeted-retry migration
and API v75 / worker v96 deployed at 12:25 UTC with exact hosted readback of all
28/40 files. The independently reviewed accepted-poll migration deployed at
12:29 UTC; its revision RPC is service-role-only and the anonymous worker returns
401. The same three security-advisor categories remain. Actual browser retries
returned HTTP 200 and queued only their selected jobs. The original company-claim
job subsequently returned `MODEL_CORRECTION_EXHAUSTED` with no recovery artifact
or new writer attempt; the recovery preconditions are under investigation.
The policy-blocked job completed at 12:33 UTC: its original OpenAI response passed
the corrected compound-word guard and all four independent verification batches.
The graph is committed with candidate_count 1 and exactly one original writer
usage record (9,035 input / 3,872 output), unchanged by retry. The four verifier
requests are separate normal usage; job total is five calls, 54,043 input /
14,310 output. This is real accepted recovery of one section, not full Word
completion. The other recovery failure is now traced to a legacy outer step
repair flag: the graph is still at initial produce, but the helper searched for
the later repair prompt hash instead of the saved original writer prompt. A
narrow original-hash recovery correction is in progress.

Release `a053d722dc191babf6edeed851e9a8e6a3d6f908` passed
[CI and Pages 39600287606](https://github.com/salahassi/tenders/actions/runs/39600287606).

Current status at 11:57 UTC: **analysis 3/3 and planning 9/9 are accepted;
eight of 67 draft jobs have completed. No complete Word has been downloaded or
inspected.** The bounded diagnostic hold expired at 10:43 and ordinary processing
resumed. At 11:52, 56 drafts were queued, one retained an in-progress model
request, and two were blocked (the original company-claim guard and a separate
output-policy failure under investigation). Since 10:34, the plan recorded 31
settled usage records with 308,055 input / 81,177 output tokens and one reserved
request. These are reported tokens, not a price estimate or a completed journey.

Company-claim correction and paid-result recovery were implemented at this
checkpoint and deployed at 12:01 UTC. In the graph executor, deterministic validation checks a verified
company source and a contiguous normalized quotation; claim paraphrases and
translations must pass mandatory independent semantic verification. Legacy
execution keeps its existing guards. The generation callback and final
validation carry the same server-controlled verification mode. Invalid writer
results are retained privately. Recovery binds an already-counted, settled
candidate to its exact job, prompt hash, graph thread and producer, rechecks
current data permissions, and resumes normal verification without another writer
POST, usage settlement or budget reset. Missing retained responses do not cause
new generation. The canonical graph replay integration passed with three original
paid candidates and unchanged writer budget 3, then required an independent
verifier before acceptance. Focused guard tests passed 16/16; the expanded
company-claims integration now passes 4/4, and recovery/graph tests passed 31/31.
Backend typecheck/build and both Deno entrypoints pass. Final full regression
`final-backend-serial-16.log` passed **800/800 tests in 52 files** (274.85 seconds).
The recovery migration is applied and API **v74** / worker **v93** deployed at
12:01 UTC, with all 28/40 source files matching hosted readback. The graph RPC
remains service-role-only, anonymous worker POST returns 401, and the same three
security-advisor categories remain unchanged. Actual browser retry and recovery
of the original experience-section job are pending; no real recovery or full
Word completion is claimed by the automated tests.

Historical status at 10:25 UTC: **all three analysis jobs and all nine planning
steps are accepted, and 67 drafting jobs have been created. No complete Word
proposal has been downloaded or inspected.** The first independent drafting
job completed at 10:22: one of 67 is accepted. Its Gemini verification used the
preserved medium profile (requested/effective medium), 9,156 input / 5,115 output
tokens, including 2,559 thinking tokens. This proves the control was sent for
that real request; it does not establish LOW performance or causality.
The first experience-section job received HTTP 200 from all three
writer models, but each response failed local `UNSUPPORTED_COMPANY_CLAIM`
validation; the job is blocked at its correction limit. Authenticated GET-only
retrieval of the two already-paid OpenAI responses confirmed the exact failing
condition: each used a contiguous quotation from an available verified company
source, but the claim wording was not a literal substring of that quotation.
The semantic truth of the claims still requires independent verification.
The temporary diagnostic returned only booleans/counts/codes, made no generation
request, and was removed immediately. Normal worker **v92** exactly matches the
canonical v90 bundle (39 files). Guard correction and paid-result recovery are
being implemented; no candidate budget or usage record has been reset.

Sixty-five queued, unstarted drafting jobs were on an audited bounded hold until
10:43 UTC while that failure is investigated. The hold changes no input, budget
or usage records and does not hold pending provider work. Completed analysis,
planning outputs and received model results remain saved. Draft acceptance,
commercial missing-input handling, review and real Word download/inspection
remain open.

The automatic Gemini reasoning migration was applied at 10:13 UTC. API **v73**
and normal worker **v90** were deployed at 10:14 UTC; exact readbacks matched all
28 API and 39 worker files. Worker v90 includes the previously deployed v89
terminal/deferred queue-wake changes. Anonymous worker POST returns HTTP 401,
and the new reasoning RPC denies anon/authenticated execution while permitting
service_role. The final complete backend regression
(`final-backend-serial-15.log`) passed **757/757 tests in 49 files** (230.53
seconds), with backend typecheck/build and both Deno entrypoint checks. Unchanged
frontend code previously passed all **192 tests**, typecheck and build. Source
`557420f7e26e9ff32642cc0a6aa1eaf01eceeb63` passed all CI checks and
[Pages 39583577517](https://github.com/salahassi/tenders/actions/runs/39583577517).

New verification operations now default to low reasoning. Existing explicit
profiles and already-started operation identities remain preserved; accepted
requests resume through GET using their original recorded metadata. Optional
Gemini reasoning controls are negotiated once only after an explicit HTTP
400/422 rejection of the exact control or level sent. Generic 400 errors, schema
errors and ambiguous requests cannot trigger that negotiation. Its recorded
compatibility decision is scoped to connection, model/settings revision,
transport and requested level. **No live successful LOW request or resulting
token/time improvement has yet been established.**

Historical checkpoint at 10:00 UTC: **analysis and all nine planning steps were
accepted; no complete Word had been downloaded or inspected.**
The authenticated Jobs page's Check retry action resumed the exact blocked step
at 09:25 (HTTP 200, same plan). Its graph is now committed with one recovery
provenance record. The original input hash, received-candidate count of one,
writer/verifier/correction budgets, and five usage records are unchanged:
65,896 input / 37,730 output tokens before and after. Recovery made **zero new
provider requests**. Subsequent independent Gemini verifications also succeeded.
Source `9daf07f559bbf981e91ca25663c3e9690552308f` passed
[Pages 39576379872](https://github.com/salahassi/tenders/actions/runs/39576379872).

The live retry exposed a separate display-state defect: successful independent
steps could overwrite the parent plan's blocked status and hide Resume. An
additive private trigger now preserves a current blocked child's status when
sibling work updates the parent, while allowing independent steps, ordinary
retry and cancellation to continue. Its audited one-time repair changes only
the aggregate status/revision, not child jobs, checkpoints, budgets or usage.
The focused canonical PostgreSQL/status/release tests passed **52/52**, backend
typecheck and independent review passed. The hosted migration is applied; the
trigger is enabled and no API role can execute its private function directly.
No existing plan needed aggregate repair at deployment. The stable full backend
regression (`final-backend-serial-14.log`) passed **693/693 tests in 47 files**
(246.96 seconds); backend typecheck/build passed. Its preceding run passed 691
cases but found a test-fixture defect:
the healthy MODEL_IN_PROGRESS case used the failure RPC, creating a second
blocked job whose ordinal could precede the expected blocker. The corrected
case uses the actual graph yield RPC and asserts retry_wait; a separate case
checks deterministic selection between two real blockers. The SQL is unchanged.
At that checkpoint, API v72 and worker v88 remained active. Frontend rerun passed all
**192 tests**, typecheck and production build; no frontend code changed.

At 09:40 UTC, eight of nine planning steps are accepted with the final step
running and no blocked child. The prior seven accepted outputs map 111 distinct
requirements into 383 section assignments, expanding to 57 prose-writing steps
under the existing eight-requirement bound. This is a measured remaining
workload, not duplicate provider dispatch. Larger prose batches remain an
unapplied experiment until actual writer/verifier output proves safe sizing;
stored mappings and task settings are unchanged. Full Word acceptance remains
pending. Failure mail has not been sent since October 20 at 17:36 UTC; the one
existing queued summary retains its configured next delivery window.

Source `8efdb3c421015a1c59ff56bccc7d86cf60805ee7` passed
[Pages 39579246925](https://github.com/salahassi/tenders/actions/runs/39579246925).
The final planning step's Gemini content-verification batch later returned
HTTP 200 / MAX_TOKENS: 8,590 input, 16,369 total output, including 15,414
thinking tokens and only about 955 visible output tokens. This was a bounded
32-unit/4,187-character content batch, not the whole report. The frozen operation
requested medium reasoning, but conservative empty capabilities resolved it to
none and omitted the control; none means provider default, not disabled
thinking. Google's documented default is also medium, so merely sending medium
does not establish a fix. A lower default for new verification work and bounded,
transport-specific optional-control negotiation were then being implemented;
the deployed follow-up is recorded above. Existing explicit profiles and accepted
requests retain their identity. Sol later accepted this same content batch;
overall planning was still unfinished at that checkpoint.

Queue timing investigation confirms successful wakes are delivered: normal
fairness assigns the next turn to an old source/assessment job, which can block
on a redirected source URL. Terminal failure did not wake the following ready
graph, adding 60–75-second idle gaps. One clean planning job spent 202 of 488
seconds in such inter-phase gaps. An additive terminal-completion wake and a
single delayed retry after the existing ten-second throttle were then prepared;
neither changes job ordering, retry schedules or concurrency. Their deployment
is recorded below; no measured live performance improvement is asserted.

Queue follow-up deployment at 10:00 UTC: both terminal/deferred wake migrations
are applied. Worker **v89** contains only the v88 bundle plus the new bounded
queue-wake helper and handler call; all **38 files** match hosted readback.
The detailed RPC is service-role-only and anonymous worker POST still returns
401. Focused queue/delay/release tests passed **76/76** and broader
worker/source/notification tests passed **110/110**, with typecheck and
independent review. The pending reasoning changes are not in this deployment.
The final planning coverage report succeeded on Gemini at 09:57:58; the local
advance-plan job is queued, competing with 44 older due assessments. Live
continuation latency and the first real draft output remain to observe.

Historical status at 09:00 UTC: **analysis is complete, but the real proposal is
blocked during planning; no complete Word has been downloaded or inspected.**
Three of nine planning jobs succeeded, one reached
`MODEL_CORRECTION_EXHAUSTED`, and five remain queued. Gemini's first rejected
verification copied source text into a candidate quotation. Luna then failed
coverage validation and Sol failed numeric-evidence validation. All returned
HTTP 200; these were local response-validation failures, not a new Gemini HTTP
400. The final corrective Sol response used 17,491 input / 8,212 output tokens.

Private replay identified an application false positive in that last saved
report: its candidate quotation contains a known evidence UUID, and the numeric
guard treats the UUID fragments as factual numbers. The 21-claim report and all
18 requirement checks otherwise validate. The narrow guard now excludes only
exact standalone supplied evidence/requirement UUIDs from numeric comparison;
unknown or embedded identifiers and actual adjacent quantities remain checked.
Known identifier digits cannot justify factual numbers on the source side.
All 57 grounding tests and backend typecheck pass. The unchanged saved report
passes full validation with zero actionable defects. Worker v87 deployed the
guard-only change at 09:12 UTC; all 36 source files matched on readback. Source
`e55a9a8c6511cc17ae72485e1bd2d445e1f10a3a` is pushed to main; its Pages workflow
39575113127 passed all checks and publication. Validated recovery of the saved report is
prepared but not deployed; no budgets or paid results have been reset, and the
blocked job has not been resumed yet. Other independent
planning work continued and reached four accepted jobs at 09:10 UTC.

Two related improvements are prepared, not deployed: private retention of each
distinct invalid verifier result (the corrective input still uses the first),
and a service-only, revision-deduplicated queue wake after successful lease
release. The latter retains normal claim ordering, a ten-second workspace
throttle, active lease/reservation checks, provider retry timing and cron
fallback. Actual first-three-plan observations showed about ten minutes of
idle inter-phase gaps without another inference occupying them. Focused checks
passed seven graph/history tests, 73 worker/source/notification tests and 39
canonical graph-release/release-command tests. Complete regression and hosted
recovery evidence remain pending.

The proposed blocked-graph recovery revalidates the unchanged current candidate
and complete retained corrective report, requires zero actionable defects and
no reserved/unknown request or saved provider round, then resumes the normal
decision/acceptance nodes. It records private provenance and preserves received
candidate counts, repair counts, budgets and usage. An interrupted acceptance
replays only the identical cached candidate with matching provenance. Twenty
helper cases and two database/LangGraph integrations pass, including the
accepted-result-write crash boundary; independent review passed. The actual
browser retry and recovered job acceptance remain pending.

Combined release validation (`final-backend-serial-12.log`) passed **679/679
tests in 46 files** in 206.60 seconds, plus backend typecheck/build and both Deno
entrypoint checks. The two additive queue-wakeup/recovery-guard migrations are
applied; anon/authenticated cannot execute their service boundary. Worker v88
deployed the combined code at 09:22 UTC; all 37 source files matched on readback
and an unauthenticated POST still returned 401. Source
`9daf07f` is pushed to main. Live acceptance remains pending. An earlier overlapping run
(`serial-11`) was inconclusive: new grounding tests were loaded against a
pre-edit module and one fixture exceeded its setup timeout; the isolated export
suite passed and the stable full run above passed every test.

Historical checkpoint at 08:24 UTC: **all three original analysis jobs succeeded**.
The final graph committed at 08:17:30 with the received-candidate count unchanged
at two. The real analysis produced 145 requirements and advanced into nine
planning jobs. The first planning writer, OpenAI gpt-6.1-sol, completed between
08:18 and 08:20 with 9,530 input / 4,145 output tokens. Its Gemini verification
then succeeded (12,417 input / 11,188 output tokens), and the first planning job
is accepted; eight planning jobs remain queued. **The end-to-end journey remains
incomplete: no complete Word proposal has been downloaded or inspected.**

API **v72** remains unchanged. Normal worker **v86**, deployed at 08:21 UTC,
matched all 36 submitted source files on readback. Its narrow continuation
optimization merges and accepts a completed final requirements-verification
batch within the same lease when at least ten seconds remain. With less time it
keeps the cached result and yields; content batches retain one model request per
worker continuation. It makes no extra model calls and preserves all validation,
leases and request identity. The change passed 106 focused tests, backend
typecheck/build and both Deno entrypoint checks. The complete backend regression
(`final-backend-serial-10.log`) passed 617/617 tests in 44 files (219.49 seconds).
The preceding complete suite passed 616/616 tests in 44 files (217.62 seconds). Source `fd629ec8c402fb27ac00803329f9dacbb33b0c7e` passed [Pages 39569125961](https://github.com/salahassi/tenders/actions/runs/39569125961), including the full package checks and publication. API remains v72 and worker v86; real Word acceptance remains pending.

At 07:53:29 UTC, a revision-guarded audited resume removed the trial's bounded
hold at job revision 176 without changing budgets, usage or saved results.
Normal worker dispatch 5580 was requested. Live readback now confirms one
recovery marker, an unchanged received-candidate count of two, and no request
for a second writer repair. Completed results were reused without generating
that unnecessary replacement candidate.

At 07:59:49 UTC, the first new verification batch using the pinned v2 instructions
(`content-2`) completed successfully on Gemini and was cached. It used 6,210
input / 5,842 output tokens in approximately 38 seconds, with no HTTP 400 or
provider failover for that call. All four content batches after the prompt change
subsequently succeeded on Gemini without failover, using a combined 24,509 input
/ 22,807 output tokens. The requirements-coverage report was cached at 08:12,
and complete analysis acceptance followed at 08:17:30. This closes the original
analysis blocker; planning, drafting, commercial missing-input handling, review
and browser Word download/inspection still have to complete.

Scheduler follow-up at 08:02 UTC: the trial's third analysis job progressed at
07:59 and again at 08:02, with two successful Gemini verification calls after
the prompt correction. Its preceding `MODEL_RATE_WAIT` was a local reservation
wait, not a provider request or HTTP 429. The current scheduler does not guarantee
a bounded wait: a local capacity wait counts as an interactive turn, its
one-minute retry can miss a newly freed model slot, and source jobs waiting over
two minutes outrank the proposal/assessment alternation. Accepted-request polls
still take priority and the single lease/reservation protections remain intact.
Record admission fairness as follow-up work; no further scheduling logic is
changed during this progressing live test. The real proposal journey and Word
download/inspection remain in progress under the main acceptance run.

Earlier completion work (API v71 / worker v84 deployed at 07:44 UTC;
exact source readbacks matched 26/33 files):
draft export now retains generated commercial/delivery inputs, model review
coverage and unresolved questions, explicitly unconfirmed. Confirmed calculations
and manual compliance take precedence; final approval requirements and separate
technical/financial volumes are preserved. Its additive export-context migration
is applied. Five draft-export tests, 25 generation tests, five commercial tests
and 13 release tests passed.

New planning and review steps use bounded requirement packing (24/12 records
respectively, at most 12,000 serialized requirement-context characters). Stored
steps are never repacked; every ordered ID remains present, and drafting,
commercial, routing and response limits are unchanged. At the earlier partial
analysis checkpoint, 96 accepted requirements packed into six planning and eight
review jobs versus eight and twenty previously. The final 145-requirement analysis
now creates nine planning jobs, as recorded above. These counts measure scheduled
primary jobs, not guaranteed model calls or completion time. Review now receives
relevant generated commercial inputs as unconfirmed content; it cannot treat them
as evidence or approved commitments.
All 41 focused generation/evidence/batching tests passed, as did typecheck,
build and Deno checks. The combined full backend run passed 591/591 tests in
42 files (223.75 seconds). A subsequent draft-only localized table-label change
passed its five export tests and typecheck. Synthetic English/Arabic DOCX visual
QA produced five/six pages with no clipped tables or page overflow; this is
renderer validation, not the original RFP acceptance artifact.

At the user's prompt-correction steering, new requests for the trial were
temporarily deferred at a safe boundary with no reserved request. Its audit
records the previous retry time and unchanged budgets/usage. The bounded hold
was extended with an audit to 08:01:58 UTC, then released at 07:53:29 after the
fix was deployed and verified. Existing accepted results remain saved. The
latest invalid Gemini quote spliced two source passages; the complete source
was supplied. The new verifier instructions make contiguous quotations and
separated references explicit at the initial request, preserving the original
input identity for already-started phases.

Private inspection of the next saved Sol report confirmed another application
defect: its three `assumption` / `insufficient` entries correctly describe
missing company inputs already retained in the candidate's questions and
owner-question fields. Treating every insufficient verdict as a rewrite caused
an unnecessary second repair to be scheduled. The narrow correction keeps
these assumptions unresolved without declaring them supported; contradictions,
unsupported factual claims, blocking findings and required coverage still block
acceptance. The exact saved report validates all 40 claims with zero remaining
repair defects; 54 focused grounding/verification tests passed. Recovery must
revalidate the saved candidate and all remaining batches without changing
received-candidate budgets or duplicating accepted requests.

Worker v84 first deployed the narrow grounding correction together with bounded
new planning/review batches; API v71 deployed the completed-draft export context
and renderer. They are superseded by API v72 / worker v85, which also contain
the separately verified prompt pin and safe false-repair recovery.

The additive `immutable_model_phase_prompt_pin` migration is applied. Its
service-only `model_phase_started` RPC denies anon/authenticated execution and
allows service_role. Immutable per-phase prompt pins preserve old user/system
bytes for previously started calls or saved rounds, including unknown or settled
usage whose result has not yet been saved. New verification phases receive
trusted system instructions requiring exact contiguous quotations, separate
references for separated passages, and explicit uncertainty for missing company
evidence. The policy version and constant instructions are included in the
input identity; existing accepted requests cannot silently acquire new wording.

Safe recovery now revalidates a retained repair-only report against its exact
saved candidate, content scope and evidence before undoing an unnecessary
scheduled repair. It proceeds only when no actionable defects remain, no next
candidate or saved provider round exists, and the service RPC and preflight
confirm the scheduled writer phase has not started. It records an idempotent
provenance marker and reverses only that unstarted scheduling increment.
Received-candidate budgets, cached reports, usage and completed results remain
unchanged. Remaining content batches and whole-candidate coverage must still
pass; this recovery cannot accept a partial report or cancel an accepted request.

The combined prompt/recovery/grounding follow-up passed 72 focused tests across
six files, backend typecheck/build and both API/worker Deno checks. An independent
private replay of the actual saved 44-claim repair-only report passed the recovery
helper's candidate, scope and evidence checks; this validates recovery eligibility,
not complete candidate coverage or live proposal acceptance. The final complete
backend run (`final-backend-serial-9.log`) subsequently passed all 616 tests.
Runtime API v72 / worker v85 readbacks verified the combined code. Source
`9bff1c8e6f8f07a4d985f3fe7d6bb09e641f2ad7` passed
[Pages workflow 39565436678](https://github.com/salahassi/tenders/actions/runs/39565436678),
including its checks and publication. Hosted smoke checks returned HTTP 200
for API health and HTTP 401 for unauthenticated bootstrap and worker calls.
These release checks do not replace the pending real Word acceptance.

At the historical 07:17 UTC checkpoint, two analysis jobs had succeeded and the
third had entered bounded repair. Its OpenAI request was accepted at 07:15 and
retrieved through the saved remote ID. The earlier workspace reservation wait
was distinct from a provider HTTP 429.

That earlier release passed **575/575 backend tests** in one run (40 files,
185.82 seconds), **192/192 frontend tests**, both package typechecks/builds and
Deno checks. API v70 / worker v83 readbacks matched 26/32 files. Its new service
RPCs denied anon/authenticated execution. Source `00d3069` was pushed to main;
GitHub Pages workflow `39561029126` passed its checks and publication. Those
release facts remain historical evidence, superseded for the backend by the
subsequent runtime releases and regression results above.

At 07:15 UTC, the additive `model_continuation_queue_fairness` migration was
applied. `MODEL_IN_PROGRESS` alone no longer gives every graph continuation
poll-first priority: that priority requires the same job/workspace's reserved
accepted remote request. New phases follow the existing proposal/assessment
alternation; leases, locks, retry eligibility and provider Retry-After stay
unchanged. The other assessment that occupied the slot completed successfully.
The queue/collection suite passed 27 tests, including six new fairness cases;
13 release-command tests and typecheck passed. The combined 575-test run passed.
At that checkpoint, the release allowlist included all five October 21 patches.

The October 20 trial had failed with only one verified analysis part. Its 16,384
token ceiling came from the application's default execution profile for a
single verification/repair response, not an account quota or demonstrated model
maximum. The changes below address those blockers without declaring the live
proposal journey successful.

P5/P6 implementation: partition large claim verification into durable content
batches plus a separate whole-candidate coverage/consistency check, including
candidates without requirement IDs. Completed batches are reused; merged claims
retain exact citations and semantic repair. Provider responses keep their original
limits while the internal merged report has a separate bounded schema. Normal
failover must finish before a corrective verification phase begins; a retained
report cannot bypass an accepted pending request. Remote resumption is scoped
to its durable phase, preserving same-phase changed-input checks. No writer
budget is reset.

A private, authenticated GET-only diagnostic retrieved Google's actual error for
an existing accepted Gemini request. Both with and without the API revision
header it returned HTTP 400 / invalid_request: "There was a problem processing
your request. You will not be charged." This is a retrieval error, NOT proof of
a terminal interaction state or zero measured usage. Google's documented issue
reports include later retrieval of affected IDs. The implementation retains
accepted IDs and unknown usage, uses GET-only reconciliation with an hourly
backoff for that exact error, and selects standard transport for new phases.
The diagnostic sent no generation and its temporary entrypoint was removed.
Gemini's internal cause remains unproven. The actual analysis envelope and schema
match the documented contract; separate latent adapter defects were fixed:
provider-default reasoning omits the unsupported `none` thinking level, and
JSON-only mode consistently omits the native schema in both transports.

An accepted OpenAI request belonged to a stale blocked assessment job and kept
the workspace's reservation occupied. Orphan reconciliation now releases that
local reservation while retaining GET-only retrieval and usage accounting. The
real orphan was subsequently reconciled with 4,569 input / 4,594 output tokens;
it was not regenerated. The original trial resumed with an audit record and
unchanged writer budgets. One real corrective analysis completed with 13,926
input / 12,178 output tokens, then proceeded to verification.

The phase reservation guard also now permits genuinely different phases while
an earlier accepted request has unknown usage. Same-phase changed input,
cross-job identical input and unstructured legacy callers remain protected.
Healthy queued/in-progress responses become eligible for GET polling after
30 seconds, allowing the next minute's cron tick to process them. Network/429
errors retain their original 60-second minimum and provider Retry-After.

Wire diagnostics hash the exact serialized POST body and native schema, record
safe sizes/transport/output/reasoning metadata, and link provider response IDs.
They never log prompts, schema content, headers or credentials. Hashing runs
alongside fetch; a held-digest regression protects streaming timeout behavior.

Earlier verification at 01:27 UTC passed 501/501 backend and 192/192 frontend
tests; the complete 569-test run above supersedes the earlier regression count
and resolves the later intermediate timing/assertion failures. Security advisory
categories remain unchanged. Temporary authenticated worker diagnostics were
removed after capturing a standard Gemini verification POST HTTP 400 /
INVALID_ARGUMENT: "Request contains an invalid argument." No field detail was
returned. The earlier API v69 / worker v82 deployment is superseded by v70/v83.

The deployed Gemini adapter now converts the canonical schema to its native
supported subset, preserving object shape, required fields, numeric limits and
supported enum/union/reference constructs. String constraints and nested array
bounds remain enforced by the complete local validator rather than expanding
the provider decoding grammar. Unsupported structural keywords fail locally.
The change covers both standard and background payloads; JSON-only mode omits
the native schema. The real verifier schema decreased from 2,732 to 2,043 bytes.
The 178 focused payload/schema tests passed. At 07:08 UTC, a real Gemini
`verify_grounding` standard request on worker v83 returned HTTP 200 / STOP
with 5,646 input and 3,182 output tokens. Its wire diagnostic confirms the
2,043-byte converted schema and provider-default reasoning. Local validation
rejected a source quotation (`EVIDENCE_REFERENCE_INVALID`), and failover
continued. This proves the deployed payload can execute, not acceptance of
that assessment or the complete proposal. Google's generic earlier 400 does
not identify which original schema constraint it rejected.

At 07:21 UTC, Gemini also completed a real content-verification batch for the
original RFP trial: HTTP 200, 5,351 input / 2,953 output tokens, and local
validation `SUCCEEDED`. This is stronger evidence than transport success alone;
the remaining batches and full proposal journey still have to complete.

At the earlier 01:12 UTC acceptance checkpoint, three scoped reports
were accepted for the corrected third analysis part. Its fourth report exhausted
the corrective verifier allowance. Private inspection found its 51 claims and
source quotations valid, with zero semantic findings, but BOQ row labels rejected
by the immediate-adjacency numeric guard. A conservative table-row repair and
batched retained-report recovery are now deployed. The unchanged retained report
passes its 51 exact claims with zero semantic defects. A targeted audited resume
reopens only its blocked graph/job/plan; all budgets and checkpoints are unchanged.
New Gemini standard requests also returned HTTP 400 / INVALID_ARGUMENT during
generation, so transport fallback alone did not solve provider execution.
Complete analysis, Word download and inspection remain pending. No successful
end-to-end acceptance is asserted.

Further real-trial inspection found a verifier taxonomy error: two statements
about absent supplied company evidence were labeled supported company facts
with no references. The deployed correction treats missing factual support as
an explicit blocking semantic defect for bounded writer repair, preserving the
original report and prohibiting unsupported factual acceptance. It does not
whitelist disclaimer phrases or reset writer budgets.

Downstream evidence preparation now retains complete already-selected immutable
RFP blocks (at most 12,000 characters each), preserving headings, qualifications
and table row context. Five targeted tests passed, including unchanged analysis
request identity and Company Knowledge selection; all eight real BOQ citations
validate against the restored downstream context. This change is included in
API v70 / worker v83.


At the 06:52 UTC continuation check, the original trial had two successful
analysis jobs and one blocked job. The plan is running at revision 50 with
evidence revision 93; its existing scoped refresh confirmed the frozen proposal
inputs remained identical. Earlier resume SQL revisions must not be replayed.
The final BOQ row guard now also rejects malformed numeric boundaries before a
page break. All remaining real row labels 9–18 validate unchanged; 49 focused
grounding/aggregation tests, typecheck and diff checks passed. An intermediate
full run encountered two timing failures and three assertions during unfinished
edits; the subsequent complete 569/569 run passed. No complete Word output is
asserted.

The reviewed deployment command now includes all four October 21 patches in
chronological order and requires both new recovery RPCs before deployment.
Thirteen release fixtures passed, including interrupted transaction/resume and
connector-applied migration idempotency.

At 06:59 UTC, the early-repair integration suite passed 47/47 tests: blocking
validated batches stop further requests for the old candidate, later accepted
requests are retrieved first, and complete coverage is independently revalidated
before accepting a result. Separate repair-only artifacts cannot be accepted as
complete reports. Existing writer budgets remain bounded. These changes passed
the final full suite and are included in the verified API v70 / worker v83
readback. The targeted audited resume of the remaining analysis job preserved
its writer/correction budgets, completed checkpoints and usage history. It
recovered the retained report, derived two blocking missing-evidence defects,
and stopped requesting further verification batches for that old candidate.
The new candidate must still pass complete verification before acceptance.

## October 20 — paid-model acceptance and runtime recovery

Current acceptance result at 22:25 UTC: **incomplete, not a successful RFP-to-Word
journey**. The real trial has one completed analysis part out of three. A
corrective verifier response for another part reached its 16,384-output-token
limit; the remaining part has genuine semantic findings after citation checks.
The plan is stopped at its existing correction limit, with original analysis,
provider IDs and usage retained. No budget was reset and no finished proposal,
business approval, submission or DOCX download is asserted.

Trial usage, counted by unique provider_usage rows: OpenAI gpt-6-luna six requests
with 102,379 input / 58,213 output tokens; gpt-6.1-sol eight requests with 121,445
input / 113,406 output tokens. Four accepted Gemini requests still have unknown
usage after HTTP 400 on retrieval. Poll activity rows are not additional
generations. No dollar total is inferred. No new opportunities were recorded
during the observation window beginning 20:25 UTC.

Remaining P5/P6 acceptance work: reduce or durably batch large verification
reports within the configured output profile; address Gemini accepted-request
retrieval without duplicating unknown work; then complete planning, drafting,
commercial missing-input handling, review and real Word inspection. The Owner's
model routes, credentials, profiles and original RFP remain unchanged.

Private inspection of the rejected corrective report found four missing numeric
matches were actual BOQ row identifiers immediately preceding the exact cited
text. Grounding now checks explicit English/Arabic item labels against that
adjacent label in the same source and requires a unique exact citation. It does
not use row numbers as support for quantities, prices, dates or other numeric
claims, and does not alter the verifier's semantic findings. Six fixtures cover
valid labels, Arabic digits, wrong/nonadjacent/ambiguous labels and invented
quantities. Worker v71 is ACTIVE and all 31 files match the submitted source.
The original real corrective response was rechecked locally against its frozen
evidence: all 68 claims passed structural/citation validation, while four
semantic defects remained for correction. This required zero external requests
and did not alter the stored response or accept the proposal. All **427 backend
tests** passed in one run, along with typecheck/build and both Deno checks.
Frontend remains at 192 passing tests with unchanged code since its verified
Pages release. Source `b45659fcfa9d65e0634015d516b36d778012cbb8` passed
[Pages 39508113535](https://github.com/salahassi/tenders/actions/runs/39508113535)
including typechecks, Deno checks, all tests, build and publication. Published
index, entry JavaScript, runtime and stylesheet match the local build. Final
runtime is API v62 / worker v71; service-only recovery permissions are intact
and the security advisory categories are unchanged. Code/release verification
is complete; the failed real end-to-end acceptance described above remains open.

Source observation exposed a separate local-capacity bug: automatic source
failure handling marked MODEL_RATE_WAIT as blocked, while the recovery helper
assumed generation had already scheduled it. The new additive
`source_model_capacity_recovery` migration schedules a one-minute retry without
incrementing outage failures or sending an outage notice, preserves explicit
provider retry times, and repairs only inactive non-canceled blocked capacity
jobs with an audit record. Source and independent discovery regression tests
cover reclaiming the same job with no outage notification. Verification and
deployment: all 421 backend tests passed in one full run, with backend typecheck
and build. The migration is applied; the real Aramco collection job moved from
blocked to retry_wait / MODEL_RATE_WAIT with an audit entry. Existing login,
browser-rendering and non-listing source blockers remain distinct.

Follow-up at 21:58 UTC: published source `4e6faacad7f55deeb6b8eac526fbc09fb4ed8f64`
passed [Pages 39502080808](https://github.com/salahassi/tenders/actions/runs/39502080808),
including all 415 backend / 191 frontend tests. API v61 / worker v68 add
content-free evidence-failure diagnostics. One actual analysis part completed
verification, writer correction and verification again: a reported requirement
count was corrected against the stored requirements. Another verifier supplied
a quote absent from its cited evidence; the guard rejected it, correctly.

P5/P6 follow-up implemented: retain a schema-valid, policy-safe invalid verifier
report privately and allow exactly one corrective verifier result for that
candidate. Original analysis, evidence validation, usage history and prior
candidate budgets remain intact. The corrective request must fix its report,
retain justified unsupported findings and quote exact evidence; a second invalid
report stops for review. This does not accept unverifiable output or reset an
exhausted writer budget. Activity distinguishes local evidence/coverage failure
after HTTP 200 from provider request rejection. Two real PostgreSQL/LangGraph
fixtures prove successful correction and terminal failure, each with one writer
and one corrective report. Policy-blocked output cannot enter the correction
cache. Focused 82 backend tests and typecheck passed; frontend 192 tests passed.
Runtime API v62 / worker v69 are ACTIVE. The QA trial was resumed with explicit
audit entries after deployment, preserving writer results, original verifier
budgets and request history. Its first corrective report was accepted as an
OpenAI background request; completion remains pending. Full backend regression
passed 397 tests, with 22 interrupted by 30-second fixture/test timeouts; all 22
passed in an isolated rerun after closing the idle browser (419 total). Both
package typechecks/builds and Deno entrypoint checks passed. New frontend
publication and live corrective acceptance remain pending. The real three-part
trial is still incomplete; no complete proposal or DOCX acceptance is claimed.

Source `1a3f5aeadc55a67177713b503da09f881b33611d` passed
[Pages 39505405656](https://github.com/salahassi/tenders/actions/runs/39505405656),
including a clean 419 backend / 192 frontend test run. Runtime readback matched
all 31 worker and 26 API files exactly. The corrective verifier report completed
but failed numeric evidence validation; its one-result allowance was not reset.
Worker v70 additionally retains policy-safe rejected corrective reports in the
private graph store for diagnosis, without recursively correcting them. A
GET-only replay was audit-requested with the exhausted budget preserved. The
other incomplete analysis part is now processing; no finished Word is claimed.

Source/capacity release `3afaffc3828b9975a373746eed041eb28310cc79` passed
[Pages 39506563063](https://github.com/salahassi/tenders/actions/runs/39506563063),
including 421 backend / 192 frontend tests. Hosted source recovery has zero
non-canceled jobs blocked solely on MODEL_RATE_WAIT; the service-only failure
RPC still denies anon/authenticated execution. Authenticated Chromium observed
the original attachment, optional company knowledge/templates, disabled
duplicate generation and current processing state. Model activity loaded 25
linked rows, showed local-validation failures and GET-only polling distinctly,
and had no document overflow at 1440px or 390px. This is hosted UI smoke evidence,
not full proposal/export acceptance.

P6 / stages 5–7: Owner configured three paid task models and requested a real RFP
journey with source/usage observation. The original confirmed file is unchanged.
The earlier legacy plan was canceled through the authenticated UI, preserving
history; a new trial uses the saved task catalog. The Owner explicitly authorized
OpenAI processing of this exact extraction during the trial. No secret, route,
model capability, business approval or QA role was changed.

Hosted acceptance exposed and corrected the following issues:

- LangGraph initialization wrote disabled tracing flags to Supabase's immutable
  process environment. Unset/disabled flags now need no write; inherited enabled
  tracing still fails closed if it cannot be disabled. Content-free exception
  locations diagnose runtime faults without exposing provider/customer content.
- Ordinary confidentiality obligations in generated analysis triggered a generic
  keyword block. Storage, authorization, runtime and upload checks now distinguish
  obligations from explicit classification labels. Credential/contact checks,
  content authorization and grounded evidence validation remain enforced.
- A failed GET of an accepted background request was recorded as skipped with
  settled but unmeasured usage. It is now a failed retrieval; unknown usage stays
  reconcilable by throttled GET without another generation. Existing affected
  records retain their request IDs and error history. Activity explains request
  duration, repeated usage records and the difference between polling/generation.

- An occupied model request slot inherited the outage backoff, delaying other
  analysis parts for an hour. Catalog reservations now identify that as a local
  one-minute wait; accepted requests and provider Retry-After remain intact.
- Real verification reports exceeded output limits. Compact verification sends
  all content units once, requests concise supported findings and exact coverage
  IDs, and persists its format. Existing accepted requests retain their original
  input while new verification requests avoid triple copies of the candidate.

Local evidence: **415 backend and 191 frontend tests** passed across the final
runs. One full backend run completed 410 tests while the five evidence tests hit
a fixture-initialization timeout; those five passed in an isolated rerun. All
compact graph/grounding/generation fixtures passed, including preserving an
accepted legacy request's input and pinning compact input across polls. Both
package typechecks/builds and Deno API/worker checks passed. The worker/database
reconciliation fixture retains unknown usage after HTTP 400, obtains measured
usage by GET, performs only one POST and never fabricates task completion.

Runtime: API **v60**, worker **v67** ACTIVE; migrations
`confidentiality_requirement_labels`, `accepted_request_observability` and
`model_capacity_wait` applied.
At 21:37 UTC, all three real OpenAI analysis results passed structural/evidence
validation and entered durable graph storage, including two recovered from their
original provider requests after the local policy fix. No repeated generation
was needed to recover them. Compact verification is running on the real trial. Grounded review, remaining analysis, full proposal/DOCX inspection,
frontend publication and end-to-end acceptance remain in progress. Gemini accepted
requests but subsequent GET returned HTTP 400; no zero-usage assumption is made.

## October 20 — automatic provider request handling

P1/P2/P5 / stages 4–7: replace the capability-assertion checkbox with automatic
request handling and an advanced standard-request override. Provider adapters
determine which APIs can resume requests. Only an explicit structured HTTP
400/422 background-feature rejection permits retrying that same model with a
standard request; the failed attempt and nullable usage are settled before a
fresh lease. Both attempts retain separate activity entries. A service-only,
lease-checked RPC reads account/model-scoped observations from the existing ledger,
with a 24-hour lifetime and configuration-snapshot reset. Accepted remote IDs
remain pollable even if the override or capability observation changes.

Local verification: **409 backend / 189 frontend tests (598 total)** passed,
along with both typechecks/builds and Deno API/worker checks. Actual graph
fixtures passed for OpenAI and Gemini; the legacy worker also completed its
same-model standard retry across two leases. Isolated Chromium exercised the
actual component's automatic default, advanced override save/reload, restoring
automatic handling and desktop/390px layouts with no page errors or overflow;
both screenshots were inspected. No paid inference was used for these fixtures.

Runtime deployment: source **`b764ea2bac744f6413a40c63928b1015f7187500`** is on main.
The connected Supabase release recorded `automatic_model_transport` as migration
**`20261020200630`**. API **v56** and worker **v58** are ACTIVE; all **26/31**
reachable source files respectively match the submitted source. Health is 200;
anonymous bootstrap and worker invocation are 401. The new RPC denies anon and
authenticated execution, permits service role and rejects a stale lease in the
hosted database. Security-advisor counts remain the previous 9 private-table
INFO / 22 authenticated-definer WARN / 1 Auth WARN. Scheduler heartbeat advanced
after deployment with scheduling enabled. Authenticated catalog reads succeed;
the QA Editor receives the expected 403 on Owner-only setup metadata.

Frontend [Pages 39489414347](https://github.com/salahassi/tenders/actions/runs/39489414347)
passed all 598 tests, typechecks, Deno checks, build and deployment. Published
index, entry script, Settings bundle and stylesheet match the tested build.
Authenticated hosted Chromium verified catalog reads, reload, desktop/390px
layouts with no overflow or page errors, QA Editor editing denial and reopening
the existing RFP plan with duplicate generation disabled. Owner override saves
were exercised in the isolated actual-component browser and database tests;
the hosted browser did not impersonate an Owner or change configuration.
During verification the user had configured three models and enabled new-work
admission. This release did not edit routes, provider selections, secrets or
admission; no live inference was initiated for its smoke checks.

Status: implementation, local verification, runtime/frontend deployment and
hosted UI smoke verification complete. Additive migration
`20261020195225_automatic_model_transport.sql` precedes compatible runtime and
frontend deployment. Tests cover exact feature rejections, negative quota/auth/
schema/gateway cases, same-target continuation in the actual graph, distinct
attempts/usage, accepted-request resume and browser-editable override defaults.
Live inference, model routing edits and new-executor admission are not part of
this UX/transport fix; paid-model acceptance remains a separate gate.

## October 20 — unified execution implementation and compatible release

P0–P5 / stages 4–7: canonical task schemas, eight API adapters, configurable
connections/models/task routes and profiles, target-aware attempts/usage and
whole-text grounded verification/correction are implemented. LangGraph 1.5.1,
checkpoint 1.2.0 and Core 1.2.18 use lease-bound private database persistence,
pending writes, immutable result caching and atomic domain commits. Inherited
external tracing is disabled. Old workers skip graph jobs; a compatible worker
can drain both executors. New-work admission is initially disabled.

The new [runbook](MODEL_EXECUTION_RUNBOOK.md) documents configuration, execution,
rollback, recovery and the paid-model acceptance handoff. New metadata and graph
state are included in hashed workspace backup; isolated restore disables model
connections/admission and cancels active work. Explicit grants/RLS remain in
each new migration. API and Pages deployment workflows now check both functions;
the backend deployment workflow also deploys/verifies the worker.

Local evidence: **386 backend tests / 33 files** passed, followed by **15 targeted
catalog/batch/recovery checks** after the final command-dispatch fix, **41 existing
database/API integration checks**, and **18 graph/catalog checks** proving no
external tracing network request even with inherited tracing flags enabled; **187 frontend
tests / 34 files**, both package typechecks/builds and Deno checks for API/worker
passed. The actual graph executor passes native pending-request resume, same-
provider fallback, bounded correction, early repeated-defect termination,
old-worker exclusion and admission rollback fixtures. A full isolated proposal
pipeline completes all stages and prepares a draft export without custom
company/template data. Empty-reference generic sections now carry their original
notice context instead of failing data authorization. Browser fixture checks
passed model creation, same-provider ordering, profile/admission saves, reload
persistence, 390px layout and absence of browser errors; desktop/mobile screenshots
were inspected. Synthetic fixture output is not live business acceptance.

Deployment update at **18:26 UTC / 21:26 Riyadh**: all additive migrations
are applied. Fresh connector requests accepted the unchanged graph RPC/domain
and recovery SQL after the earlier MCP `Invalid or expired requestState` errors.
No new secret, permission relaxation, database reset or queue reset was needed.
The request-state error came from the connector confirmation path; its exact
server-side cause is not proven by the client response.

Hosted migrations: `20261020155016` (`model_catalog_and_task_routes`),
`20261020155037` (`model_target_identity_and_execution`),
`20261020160954` (`durable_model_graph_storage`),
`20261020181506` (`durable_model_graph_store_rpc`),
`20261020181537` (`durable_model_graph_domain_commits`) and
`20261020182128` (`model_graph_recovery_and_retention`). The three graph parts
are the exact statement boundaries of local `20261020143042`. The optional
release runner now recognizes all three parts as complete and rejects incomplete
out-of-order history, so a later release does not replay their DDL. All **8 release-runner tests**
passed, including the actual completed split-history shape.

Runtime source `5e3e088e5977facd245b3119a17053451b7acf1a`: API **v54** and
worker **v56** are ACTIVE. All **26 API / 31 worker reachable files** returned by
Supabase match the submitted source exactly. Health returns HTTP 200; anonymous bootstrap and worker requests return 401. Minute
worker dispatches return 202; the 18:26 database heartbeat confirms background
execution. New catalog tables have member-read RLS and no anonymous grants;
private graph tables deny browser reads, and claim/store/commit RPCs remain
service-role-only. Original RFP hash is unchanged. New-work admission remains off
for the staged paid-model acceptance; existing jobs retain legacy execution.
Frontend merge **`bacebc98f95ea2c80f8ee6b17fce42d1d988e48d`** is published.
[Pages 39475172310](https://github.com/salahassi/tenders/actions/runs/39475172310)
passed **395 backend / 187 frontend tests (582 total)**, both package typechecks,
Deno API/worker checks, build and deployment. Backend build/typecheck also passed
locally after the final runner change. Published index, main/runtime scripts,
stylesheet and Settings bundle match the tested build byte-for-byte.

Authenticated hosted Chromium verified all four catalog reads (200), the
Owner-only setup endpoint denial for the existing QA Editor (403), disabled
Owner editing controls, settings reload, desktop/mobile layout and reopening the
existing RFP plan with duplicate generation disabled. There were no page errors.
The persistent browser initially showed cached legacy settings; cache-disabled
reload loaded the verified new bundle. Owner configuration saves were exercised
in the isolated actual-component browser tests and database/API tests, not by
impersonating an Owner in the hosted browser. No synthetic business records,
new external model requests or replacement originals were created for this smoke
check. The paid-model canary and new-executor admission remain pending; this
compatible release does not claim a live graph or complete Word acceptance.

Historical fallback [workflow 39457435238](https://github.com/salahassi/tenders/actions/runs/39457435238)
stopped at its Actions credential check and deployed nothing. This release instead
used the already connected Supabase tools successfully. `SUPABASE_ACCESS_TOKEN`
is needed only if choosing that separate Actions deployment path; it is not a
new application requirement or a blocker for this connector release.

Security-advisor counts remain 22 pre-existing authenticated-definer warnings,
one Auth warning and nine intentionally private no-policy informational entries.
No new exposed graph RPC or table was found. At 18:36 UTC scheduling remained
healthy, with zero graph admissions and zero versions for the existing trial.
Failure-email history was 46 sent (last 17:36 UTC, before runtime deployment),
with one pending grouped failure summary; notification preferences were not
changed or disabled by this release. Full fresh MAIN-01–14 and E2E-01–10,
actual inference quality and downloaded Word acceptance remain pending the
Owner-provided paid models. The complete isolated pipeline and browser fixtures
are implementation evidence, not a live business proposal pass.

## October 20 — staged release and paid-model acceptance order

The Owner clarified that the application must keep working throughout the model
upgrade, and that paid models will be added after the implementation is ready.
The full main-process test then starts from the beginning. This ordering
supersedes the earlier same-day acceptance target recorded below.

Updated [MODEL_EXECUTION_PLAN.md](MODEL_EXECUTION_PLAN.md) links P0–P6 to release
gates R0–R7 and defines MAIN-01–14 alongside E2E-01–10. The plan preserves current
records, approvals, routes, queue leases, accepted remote requests and legacy
executors; additive database changes precede compatible API/worker/frontend
releases. It includes per-migration explicit GRANT/RLS checks for the October 30
Data API change, canary admission, rollback compatibility, the paid-model setup
handoff and protected evidence for actual downloaded artifacts.

Status: **planning update only**; no runtime, production schema, model settings,
credential or billing change. The update passed **30 relative-link checks**,
`git diff --check`, **330 backend tests / 29 files**, **183 frontend tests / 33
files**, and both package typechecks/builds. Plan source
**`19ad73e901328a5bf57f6f6c9cd798838c1d84db`** is published on main;
remote commit/tree and plan/checklist bytes match local source. No deployment
workflow ran for this documentation-only commit, as expected. Main-process and
paid-model acceptance remain unperformed
for the planned implementation; prior checks are retained as historical evidence.

## October 20 — unified model execution implementation plan

The Owner requested a complete plan for structured requests/results across every
model task, per-task multiple-model routing (including models from the same
provider), grounded validation/correction, LangGraph, configurable output/reasoning
profiles and real RFP-to-Word acceptance. The new
[Model Execution Plan](MODEL_EXECUTION_PLAN.md) maps packages P0–P6 to the original
M1–M6 milestones, stages 1–7 and AT01–AT30. Its precedence decisions are recorded
in [DECISIONS.md](DECISIONS.md); the original specification links to the extension.

Implementation status: **planning documentation only**. Current model contracts,
provider identity/ledger, generation validators, Word renderer and Decimal
calculator were inspected. Official provider, LangGraph and Supabase references
were checked. No runtime, model configuration, credential, permission or billing
change is part of this documentation release. LangGraph is a planned, compatibility-
gated library inside the existing worker, not an extra hosting dependency.

Read-only hosted baseline at **2026-10-20 11:17 UTC / 14:17 Riyadh**: the authorized
existing RFP trial remains in analysis with `MODEL_ROUND_EXHAUSTED`, one completed
step, thirteen queued leaves, eleven split parents and **zero proposal versions**.
Recent sent requests from Gemini, Groq and z.ai returned 429. P0 prioritizes the
actual draft/download/regeneration journey on October 20 without waiting for the
full refactor. E2E-01–E2E-10 distinguish real artifacts, isolated fixtures,
provider availability and final business approval; no live proposal pass is claimed.

Verification: all **43 relative documentation links** checked successfully;
**330 backend tests / 29 files and 183 frontend tests / 33 files** passed, with
both package typechecks/builds and `git diff --check`. These are existing
regression checks, not implementation evidence for the planned features.
Published plan source **`50307a68b88409571071d1012332bc8c03dc076d`** is on main;
the GitHub commit/tree and returned bytes of the plan, checklist, specification
and decisions match local source. The documentation-only commit has no Actions
deployment run, as expected from the workflow's path exclusions.
Runtime remains API v53 / worker v55. Documentation-only publication does not
require or claim a new application deployment. Earlier dated entries below
remain historical evidence; the new plan does not mark their open acceptance
items complete.

## October 20 — processing independent of the request connection

The Owner requested durable background processing and confirmed there is no additional server. Deployment stays on Supabase; a permanent external worker is **not** provisioned or claimed. The authenticated worker acknowledges dispatch with HTTP 202 and registers processing with `EdgeRuntime.waitUntil`. Its database job/lease remains authoritative after the HTTP caller disconnects. Model work has a 130-second invocation budget, leaving headroom within the documented 150-second free Edge runtime. A fresh attempt receives at least 90 seconds, up to 120 seconds when invocation time allows; otherwise the existing durable continuation resumes in a fresh invocation. This is bounded background execution, not unlimited runtime.

Gemini and OpenAI Responses accepted request IDs are persisted and retrieved across invocations. Transient polling failures/429s retain the same pending request and do not trigger another provider while its result is still unknown and retrievable. Definitive terminal failures preserve measured usage and permit failover. OpenAI native background mode is now implemented independently of model names, with stored results deleted after successful persistence; actual OpenAI acceptance remains unverified because no key is configured. New remote checkpoints bind the configured project as well as provider/model/prompt; legacy checkpoints retain their prior compatibility. Canceled outputs are only reconciled for usage, never published.

Synchronous chat-compatible providers and Claude stream responses when called by the detached worker. A 90-second idle timer resets on received stream data, while the independent bounded invocation deadline remains. SSE assembly handles fragmented UTF-8/CRLF, recorded usage and terminal markers, excludes reasoning text, rejects oversized/error responses and does not accept a cut stream as a complete result. Unsupported real provider responses still follow the recorded failover path; no model-specific name, artificial successful output or invented usage is introduced.

Verification: **330 backend tests / 29 files and 183 frontend tests / 33 files**, both package typechecks/builds and Deno entrypoints passed. The focused transport/worker/PostgreSQL cases cover a 100-second active stream, 90-second idle, hard ceiling, disconnected caller, same-request Gemini/OpenAI polling through a 429 and lost lease, transient polling failure, terminal failover and existing usage/content/identity guards. Hosted migration `20261020100949` is applied; API **v53** / worker **v55** are ACTIVE. Remote-request RPCs remain service-role-only; health returns 200 and anonymous jobs/worker requests return 401. All **38 reachable runtime files** match the tested source exactly. Security-advisor categories and counts are unchanged (4 private-table INFO, 22 existing authenticated-definer WARN, 1 password-protection WARN). Minute dispatches at 10:11 and 10:12 UTC returned HTTP **202** without timeout, with a later database heartbeat confirming background execution. Authenticated Chromium reopened the same saved plan with no page errors or horizontal overflow; duplicate generation remains disabled. Source `bd0cf5ed2b5bd3686c4b813d78f3ee00f14e736e` is published to main; [Pages 39406261935](https://github.com/salahassi/tenders/actions/runs/39406261935) passed both build and deployment, including all **513** application tests. No additional processing email was sent: the count remains 45, last sent October 19 at 17:35 UTC. The authorized QA browser was closed cleanly; its account remains for the pending real proposal trial. The real proposal still has one completed analysis leaf and thirteen queued leaves; live configured providers are under recorded cooldowns. No Word output is claimed.

## October 19 — environment-browser RFP trial

The Owner explicitly authorized a temporary QA user and use of the existing mismatched opportunity/RFP for this trial. This supersedes the earlier requirement to relocate the file. A temporary Editor joined through the normal invitation, email confirmation and password sign-in flow; no administrative provisioning endpoint was deployed. Headless Chromium in the project environment authenticated against the published application. The original 21-page PDF downloaded through the application's Storage route, with the exact stored SHA-256 verified. Extracted text retained all 21 page markers; its requirements, SLA table and 18 BOQ items were checked against the original. The Editor confirmed extraction and created proposal plan `68443ce9-3908-41f7-a309-110f230080c9` through the UI without a template or company files. No buyer metadata, rates or company claims were fabricated.

The trial exposed a roughly 66-second workspace load caused mainly by sequential pages of around 1,800 historical jobs, and proposal work waiting behind automatic assessments. Operational history now requests bounded 500-record pages (other resources remain at 100), retaining all cursors/history and membership/RLS checks. The queue alternates eligible proposal work with waiting assessments while preserving accepted remote requests, waiting source priority, provider retry times and one live workspace lease. Model content checks now match the existing storage check for the word Confidential; ordinary confidentiality requirements do not incorrectly match that word. Explicit per-content provider authorization remains required.

Verification: **295 backend tests / 27 files and 183 frontend tests / 33 files**, both package typechecks/builds and Deno entrypoints passed. The migration is deployed; authenticated worker-claim access remains denied and service access remains granted. API **v47** and worker **v49** are active; all **36 reachable runtime files** match tested source exactly. Public health returns 200, unauthenticated API and worker calls return 401, and security-advisor categories are unchanged. A real request under the QA browser session returned 500 jobs with a continuation cursor; the local PostgREST cap now accommodates that batch plus its lookahead row. The first proposal attempt ran and correctly stopped at `DATA_AUTHORIZATION_REQUIRED`, before provider processing.

The Owner explicitly approved both the exact RFP processing via Gemini/Groq/z.ai and PR #5 publication. The three exact-hash content grants were saved through the audited application command. Source `d6496f052bb2bd8b56805224772e6846d1f1dc05` is on `main`; [Pages run 39338756725](https://github.com/salahassi/tenders/actions/runs/39338756725) passed. The same authenticated browser's workspace reload improved from 68 seconds to 17 seconds. Permissions and publication are no longer pending.

Actual Resume saved work exposed a separate legacy `USAGE_REVIEW_REQUIRED` guard: unrelated historical unknown usage blocked a proposal that had not been sent. The follow-up migration delegates ambiguous-call checks to provider reservation when automatic routing is enabled. Active reservations and legacy manual policy still block resume; same-provider/input duplicate protection and recorded unknown usage remain intact. Four PostgreSQL cases cover automatic/manual mode with unknown/reserved usage. All 71 generation/routing/continuous-model checks passed. Hosted migration `20261019231234` is applied, with the private security-definer ACL unchanged. Actual browser Resume returned HTTP 200 and queued the same saved plan; the scheduler resumed it without duplicate plan creation. The resumed plan is waiting automatically for provider availability; actual generation and Word download remain pending. No generation success is claimed. The temporary QA Editor remains active for this trial; credentials/customer files stay outside the repository.

Provider timing follow-up: live z.ai attempts consistently ended at the application's 20-second timeout. Automatic rounds now share a 90-second request allowance among actually configured providers whose cooldown has elapsed, so a sole available provider is not shortened by unavailable alternatives. Background polling keeps its existing 20-second bound. Timeout/network classification is recorded without raw errors or customer text; ambiguous usage remains unknown. Fake-clock transport tests cover a 25-second valid proposal response, a timed-out provider followed by success, all providers timing out, and the existing single-provider diagnostic. No provider-specific model name or billing gate is introduced. UI copy distinguishes active preparation and provider waiting from readiness to start.

Follow-up verification: **302 backend tests / 27 files and 183 frontend tests / 33 files** passed; both package typechecks/builds passed. Both Deno entrypoints passed with the repository CI version 2.9.6. API v48 and worker v50 are active. All 36 reachable runtime files match the tested source. Source `0ad8ce97a168c8b46464491327f0b652d7697e84` passed [Pages 39341417085](https://github.com/salahassi/tenders/actions/runs/39341417085). Public index, main JavaScript, stylesheet, runtime and opportunity bundle match the tested build. Health returns 200; anonymous jobs and worker calls return 401. Actual hosted Chromium shows automatic waiting and disables duplicate generation. No further failure mail was sent: 45 historical processing messages remain; one summary waits until the daily interval on October 20. Subsequent provider results remain pending.

Authenticated mobile inspection found a real 481px horizontal overflow at a 390px viewport, caused by the global navigation/actions row. The small-screen header now wraps its action groups while preserving Refresh and Sign out. The authenticated browser preview fits both 390px and 320px without horizontal overflow, retaining the visible Refresh/Sign out actions and disabled duplicate generation. Frontend typecheck/build and all 183 tests passed again after the CSS change. Backend remains the unchanged 302-test source verified above. Source `f36e0d4e49982e969cbe8fa290ec73e3f9e43bb4` passed [Pages 39342635409](https://github.com/salahassi/tenders/actions/runs/39342635409), including the full checks and deployment. The public index/main/CSS/runtime bytes match the tested build. Authenticated hosted reload at 320px now has no horizontal overflow; the pre-reload cached page still had the old stylesheet. Actual proposal generation remains pending provider availability.

Live proposal processing resumed automatically at 23:45 UTC. z.ai returned real HTTP 200 responses after **59.7 seconds** and **84.7 seconds**, with measured input/output of **3,789/4,096** and **3,738/4,096** respectively. Both were truncated, proving that the previous 20-second timeout hid actual provider responses. Automatic routing then hid the measured truncation behind MODEL_ROUND_EXHAUSTED, preventing the saved generation step from using its existing split/repair path. The correction preserves the measured output error for persisted proposal tasks after trying every provider; source/probe/assessment exhaustion behavior is unchanged. A database + real model adapter fixture now proves automatic truncation splits into overlapping complete source ranges and the saved plan subsequently completes; usage stays measured. Expanded output-recovery/model/generation checks pass (**68 focused tests**). Full backend verification passed **309 tests / 27 files**, both package typechecks/builds and Deno checks passed (frontend unchanged at 183 tests). API v49 / worker v51 are ACTIVE with all 36 reachable files matching source. GitHub publication and hosted split acceptance remain pending. Subsequent z.ai 429s report provider overload; availability remains external.

## October 20 — full 90-second provider attempts

The Owner explicitly requires at least 90 seconds per provider attempt. This supersedes the shared 90-second round budget above. Every generation POST, including Gemini background submission, receives 90 seconds independently. Read-only background polling retains its short timeout. If there is insufficient invocation time to start another full attempt, the leased worker checkpoints the remaining provider identities, original prompt hash, measured output error and retry windows, then releases the job for automatic continuation. Fresh provider configuration/authorization is rechecked; completed providers are not resent, unknown usage remains unknown, and the logical round counter is preserved. The checkpoint is service-role-only and rejects stale leases, cancellation, changed inputs and unknown identities. A later exhausted round can still reach the bounded split/repair path. Verification: **313 backend tests / 27 files and 183 frontend tests / 33 files** pass, both package typechecks/builds and Deno entrypoints pass. Transport tests allow a 75-second successful response and a full 90-second timeout on each provider across continuations. Database tests cover priority/round-robin order, unchanged logical round number, lease release, identity/input validation, canceled jobs and denied browser RPC access. Two long multi-step integration cases now allow 15 seconds instead of the default five; their full assertions are unchanged. Migration `20261020001729` is applied. API **v51** / worker **v53** are ACTIVE; all **36 reachable files** match tested source. New RPCs are service-role-only; security-advisor categories/counts are unchanged. Generation starts within the first 20 seconds of a worker invocation, leaving its full 90 seconds plus settlement inside the existing 120-second dispatcher deadline. The three existing trial analysis jobs were audit-rescheduled once after deployment; their failure counts, provider Retry-After and unknown-usage guards were preserved. GitHub publication and actual hosted generation/download acceptance remain pending.

## October 20 — scoped evidence recovery during the real RFP trial

The 90-second release `5c85d34b0c024eadac22f67c2e0da1159397eaff` passed [Pages 39383520652](https://github.com/salahassi/tenders/actions/runs/39383520652). During unattended production execution, z.ai reached an actual **90,692ms** timeout, and later produced one valid analysis after **42,976ms**. Eleven measured truncations followed the persisted split path; one leaf completed, with thirteen leaves still queued when a global evidence revision change blocked them. The RFP extraction hash/revision and company inputs were unchanged. Comparing fresh/frozen context found only classifier-only notice metadata changed (`fetched_at`, raw detail HTML hash); the workspace-wide revision guard incorrectly treated this as a changed proposal input.

Follow-up implementation checks the current proposal snapshot against every frozen proposal input before advancing its evidence revision. Only the three fields consumed exclusively by classification are omitted from that equality check. Actual RFP, buyer notice text, language, template, company evidence, rates and review changes still block stale work; the frozen context/input hash and completed steps are retained. Assessments and existing approval invalidation retain their prior guards. Generation outputs now use the already-supported 8K ceiling, giving reasoning-enabled models room to finish JSON instead of repeatedly cutting analysis/planning at 2K–4K. This remains a response bound, not a daily token quota. Verification: full backend **317 tests / 27 files** passed, then the expanded **24-test generation suite** passed including a populated migration recovery case (318 current backend tests). Frontend **183 tests / 33 files**, both typechecks/builds and Deno checks passed. Hosted migration `20261020071647` is applied; API **v52** / worker **v54** are ACTIVE with all **36 reachable files** matching the tested source. The private refresh helper is not callable by browser roles. Production recovery requeued all **13** unchanged-input jobs, retained the completed/split jobs and original frozen context, and advanced the proposal evidence revision from 57 to 77 with audit evidence. Source `790fdbee83d9fdc26ac2abe97d368f1485053c14` passed [Pages 39385855838](https://github.com/salahassi/tenders/actions/runs/39385855838), including both package checks, **318 backend / 183 frontend tests**, Deno and publication. Authenticated Chromium shows the same saved proposal actively preparing/waiting, with duplicate generation disabled and no horizontal overflow. Health returns 200 and anonymous jobs/worker access returns 401; security-advisor categories/counts remain unchanged. The recovered proposal now reaches model routing without STALE_INPUT: the first subsequent Groq attempt returned HTTP 429; z.ai is under shared outage backoff and Gemini has a recorded Retry-After. At 07:22 UTC the plan remained running/analysis, with 13 unfinished leaves (10 queued and 3 automatically retrying), one completed leaf and eleven split parents. There are still **zero proposal versions and no hosted Word download**. The minute scheduler continues with a fresh heartbeat; failure emails remain at 45, last sent October 19 at 17:35 UTC. Provider availability and completion of the real generation/download trial remain open; no finished tender output is claimed. The authorized QA account remains for this pending trial.

## October 19 — Repeated processing email incident

The Owner reported an Outlook notification burst. Production records showed 42 legacy per-job processing emails followed by three hourly grouped emails (45 accepted processing messages total); no mail was pending at investigation time. Grouping by newly affected task still repeated an already-reported model outage. The Owner's failure interval was changed from its inherited one-hour default to 24 hours with an audit event; failure alerts and review reminders remain enabled.

Implemented cause-level incident memory: additional tasks do not resend the same continuing failure; a cause can alert again after observed recovery, subject to the recipient's interval. Daily is the default for new preferences. Historical sent/ambiguous messages seed incident state, pending summaries recheck current failures and the sending interval, and claim/tick follow the same workspace lock order. Definite SMTP failures retry the same delivery; ambiguous delivery stays final. Pre-opt-in notifications are excluded. The current summary includes all active causes rather than only newly affected tasks.

Provider diagnostics also showed repeated 429/500/uncertain requests without Retry-After. A shared per-provider/model backoff now derives a 1-minute to 1-hour wait from consecutive actual failures, honors longer provider Retry-After, ignores skipped attempts, resets on a response, and leaves other providers/models eligible. This changes retry admission, not model outputs or unknown-usage accounting. Provider availability is external and is not claimed fixed. Verification: **291 backend tests / 27 files and 182 frontend tests / 33 files**, both typechecks/builds, and 23 focused migration tests pass. To work around two connector `Invalid or expired requestState` failures on the combined migration, the same tested SQL was split into four smaller migrations; they and provider backoff are deployed. Hosted versions: `20261019184106` backoff, `20261019184529` incident state, `20261019184752` preferences, `20261019184804` tick, `20261019184813` claim. All nine function bodies match local SQL hashes. Repeated live ticks produced no pending mail or duplicate sends: 45 historical processing messages remained 45. The four existing active causes are remembered; browser reads of private state and browser delivery claims are denied, and service claims are retained. Post-migration advisors show no new exposed-function warnings; the extra RLS-without-policy item is the intentionally private incident state. No extra test email was sent. API v46 and worker v48 are unchanged. A navigation test now waits for the opportunity route before clicking its proposal link, avoiding a stale-route match exposed under concurrent test load.

Published source `0e90336f87b2148fdb9e8f2fed4698a553e9ca0f`; [Pages run 39306430929](https://github.com/salahassi/tenders/actions/runs/39306430929) passed frontend/backend checks, all 473 tests, Deno checks and deployment. Public HTML and the updated Settings JavaScript match the tested local build byte-for-byte. At 18:54:49 UTC, processing-email count was still 45 with no queued/sending/retry deliveries; scheduling was enabled with an 18:54:02 heartbeat. Actual model activity from 18:42 through 18:55 showed 13 Gemini, 14 Groq and 14 z.ai wait skips without HTTP requests; one intervening Gemini request still returned 429. This verifies shared waiting in production, not recovery of the providers themselves. Hosted RFP-to-proposal acceptance remains the separate pending task below.

## October 19 — RFP-first proposal trial and usability

Hosted session follow-up: the Owner saved a new TinyFish session and run `cdb0bdb5-e244-484c-950e-40c5e1d06afc` confirmed authenticated Owner access to IIH, the uploaded RFP awaiting extraction confirmation, and zero proposals. TinyFish then reported insufficient wallet balance for another run; browser upload/generation/download remains pending. Read-only database evidence confirms the actual uploaded document is **NHCI Strategic Intelligence Platform** for **NHCI Innovation**, while its linked opportunity is the An-Najah digital-security/mobile-app expert notice. The browser report's inference of construction from the generic filename was unsupported and is not used. Preserve both records; a correctly matched opportunity is needed for the trial. The Proposals empty state incorrectly described backend connection as a future step even in a connected workspace. Its copy now describes the actual upload/review/generate path and optional templates/Company Knowledge. Verification: 182 frontend and 291 backend tests pass with both typechecks/builds. An initial simultaneous run exceeded timing limits in existing tests; separate runs with bounded workers passed without test or assertion changes. Published source `754b03e464f0b9cd971004b4f91ae74073aaa071`; [Pages run 39309224523](https://github.com/salahassi/tenders/actions/runs/39309224523) passed all checks and deployment. Public HTML and Proposals JavaScript match the local build byte-for-byte. No backend runtime or database changes were required; no hosted proposal success is claimed.

Owner requests a real RFP upload-to-download trial and preparation without custom templates or sufficient Company Knowledge. Initial hosted read-only findings: no saved templates or proposals; one RFP with extracted text but no extraction confirmation. Browser sign-in is pending; no hosted upload-to-download success is claimed.

Implemented: generation controls colocated with language/input context; direct pending-extraction review; accurate readiness stage and cloud-persistence guidance; workspace refresh when generation completes; full draft download clearly separate from final approval controls. Generation instructions require a substantive RFP response without inventing company facts; an empty knowledge collection is advisory, while actual mandatory evidence and pricing questions retain their gates. No schema changes.

Verification: **285 backend tests / 26 files and 182 frontend tests / 33 files** pass, plus both typechecks/builds and Deno entrypoint checks. The new database-backed generation test completes all sections with no templates, knowledge or rates; its model responses are fixtures. A real Chromium Web Worker packages that exact resulting export model into a 969,997-byte Word file, and canonical server verification accepts its content. Separately, 24 local Chromium checks cover desktop/mobile navigation, an actual file input/extraction, Arabic review persistence and draft download, with no browser errors or external requests. These tests do not establish hosted Auth/Storage or live model quality. The multi-page navigation test has a 15-second total allowance because lazy routes can exceed the default five seconds; assertions are unchanged.

Hosted findings: the existing uploaded RFP describes a different project/client from its linked opportunity notice. Preserve both the original file and current record; use a correctly identified opportunity for the real trial. No synthetic records were inserted in production. Hosted browser sign-in and live upload-to-download acceptance remain pending; no actual tender approval or submission was performed. Published source `8ea8bc0b028d12895b34bd4128731fef00835407`; [Pages run 39289928588](https://github.com/salahassi/tenders/actions/runs/39289928588) passed the complete CI and deployment. Worker v48 is active and all 19 readback files match the intended package; only generation.ts changed. API v46 and the database schema are unchanged. Public HTML and affected JavaScript assets match the tested local build byte-for-byte. API health returns 200; scheduling remains enabled with a fresh heartbeat. During the live read-only observation, Gemini/Groq had provider rate-limit responses and z.ai had rate-limit/overload/uncertain-network responses; Groq also had one recent successful assessment. These background assessment results are not proposal acceptance.

Verified October 18, 2026 (Asia/Riyadh). This file separates code, deterministic tests, deployment, and actual hosted acceptance. Requirements remain in [IMPLEMENTATION_SPEC.txt](IMPLEMENTATION_SPEC.txt); later [DECISIONS.md](DECISIONS.md) and the [frontend handoff](../../frontend/docs/FRONTEND_HANDOFF.md) apply. Historical investigation checkpoints remain in Git history and [INTEGRATION_TEST_REPORT.md](INTEGRATION_TEST_REPORT.md).

**The application is deployed with an active scheduler, real official collections and working Gemini inference. Full hosted proposal acceptance is still incomplete.** Full system activation, migrations, publication and tests are already authorized. Do not request the same permission or another Google login. Only Gemini is configured; optional provider credentials and actual tender costs must never be invented.

## Current release and completion results

- Runtime: API **v15**, worker **v12**, all 14 retained files each match source `a2c3bb0e7aad4092054a04ae7cf8e46184de87de`. Both Deno entry checks passed. Minute scheduling is active; source interval is six hours. Runtime hashes and migration mappings are in [DEPLOYMENT.md](DEPLOYMENT.md).
- Published PDF fix: source `2d8380ec981ab43a386e194efef0c3b1221a789f`, successful [Pages run 39080451104](https://github.com/salahassi/tenders/actions/runs/39080451104). PDF.js library handshakes no longer prematurely resolve/terminate document extraction.
- Four reviewed exact-URL public collectors are active: Jordan GTD, An-Najah, Ramallah and IsDB corporate procurement. Real scheduled collection produced **35 opportunities and 35 snapshots**: 6 GTD, 19 An-Najah, 10 Ramallah; IsDB completed with no open notices. The other 31 official directory entries remain manual destinations, not active collectors. See [SOURCE_COLLECTION.md](SOURCE_COLLECTION.md).
- Owner browser saved and reloaded the user-supplied public IIH company profile and verified it (revision 2). Its exact text and one actual Ramallah notice are authorized for Gemini. No claims of certifications, past projects, staff availability, rates or commercial approvals were fabricated.
- Tender costs now have direct dated scope-specific entry with auditable Owner approval and retry without duplicate creation. Currency is suggested from country (SAR/JOD/ILS), with tender requirements taking precedence and existing saved estimates preserved. A fixed company price list is not required.
- Owner browser exposed processing controls hidden until shortlisting. The current change exposes assessment/progress/resume/cancel for an unselected discovery and removes obsolete disconnected messages. Role restrictions and expected revisions remain intact. All 143 frontend tests/26 files and typecheck/build passed; published by [Pages 39081277000](https://github.com/salahassi/tenders/actions/runs/39081277000), source `82e9ffbd63ccb74c7e47f7bfd6f375920d67d2b4`.
- Queue migration `20261017234946` is deployed as hosted `20261017235442`. Claim hash `8cc7ff949e99c9763a476dcbe6e5a4e5`; authenticated execute false, service execute true. A follow-up covers source jobs already blocked by STALE_INPUT and all saved generation continuation stages. The follow-up is deployed as `20261018000051`; canonical file `20261017235819`, claim MD5 `9e8c911861a7c48d91fce7b7fbdfebda`, unchanged service-only grants. All 171 backend tests/21 files and typecheck/build passed. Exact content permissions remain enforced.
- Final application checks: **171 backend tests/21 files and 143 frontend tests/26 files**, both typechecks/builds passed. The private actual-metadata recovery drill also passed separately. Concurrent package runs hit the existing UI journey timing limit; the isolated final frontend run passed every test without changing timeouts or assertions. Do not count retries as extra tests.

## Actual browser and data evidence

- Real Owner TinyFish profile works. Directory filters/details, preferences/reload, navigation, Gemini configuration, automatic round robin and completed diagnostic reload are verified. Do not fabricate an account or rotate credentials to obtain another session.
- Public IIH note save/reload: run `1a853873-0f10-4149-b641-df719ece93c8`. Verification and exact Gemini content permissions: `ed2fe939-6e85-4654-bb32-0e37f63f430d`.
- Ramallah source pause/reload/resume: run `4bd07bee-03f3-467f-b5f2-325dd8a61f2f`, independently confirmed at source revision 4. The old repeat job blocked on its earlier revision; latest migration canceled that obsolete job and queued revision 4. The revision-4 repeat succeeded at 00:02:04 UTC, processed the same 10 notices, and preserved totals at 35 opportunities/35 snapshots with zero duplicate source identities.
- Actual Chromium extracted a public 87-page procurement PDF into 143,462 characters, retaining Arabic and technical English, status ready, with original SHA-256 `95249b383c62dd2fe277889fc796120694442e8882e672d0ce4fd756831c0238`; no browser errors. This revealed and verified the PDF worker fix. Public bytes/text remain outside the repository.
- Published anonymous sign-in at 390×844 was visually reviewed with no horizontal overflow. Authenticated mobile is not established by this result.
- Actual cloud snapshot: **437 metadata rows, zero files**. Every row hash passed, and production restore RPCs restored it into isolated local PostgreSQL with 35 opportunities, 35 sources and one knowledge record. Restored sources were paused and access identities were not copied. Private snapshot and temporary harness remain outside the repository. This is not original-inclusive or hosted-target restoration.
- TinyFish run `bf80a51f-1139-47f6-b6a3-b6fa30e1ad1a` could not create/select upload files with its available browser tools. No actual hosted original upload happened. Do not equate local extraction or fixture object transport with hosted Storage acceptance.

## Stage status and remaining acceptance

| Stage | Implemented and verified | Remaining actual acceptance |
| --- | --- | --- |
| 1. Identity/core | Invitation-only email/password, restricted Owner, membership/RLS, revisions, audit/idempotency; actual Owner session and persisted settings. | Hosted multi-role/cross-workspace journeys and authenticated mobile forms. Do not create fake cloud users. |
| 2. Files/review | Private original reservations, byte/signature/hash checks, extraction/packages/addenda, scoped text/files/retries; actual Arabic PDF extraction and verified company note. | Eligible real original prepare → upload → download with exact bytes in hosted Storage. Browser tool lacks file-input capability. |
| 3. Collection/background | Four public collectors deployed, 35 real notices, minute scheduling, immutable snapshots, deduplication fixtures, actual pause/resume. | Hosted repeat/pause/resume/deduplication passed; other portals require their own suitable public feeds/adapters. |
| 4. Free providers | Gemini live inference/usage and background retrieval verified. Automatic Gemini → Qwen → Mistral → Groq round robin enabled; missing config skipped without HTTP. Unknown usage retained without same-input resend. | Actual alternative inference requires genuine free-only account configuration. Simulated outage/quota cases are explicitly local fixtures. |
| 5. Assessment/proposals | Grounded weighted assessment, persistent generation/regeneration, feedback, decimal costing/delivery, evidence-bound approval; full production pipeline integrated against local DB/provider fixtures. | Live notice assessment completed at 00:01 UTC with insufficient evidence (no invented score); eligible confirmed RFP → real proposal → scoped feedback → regenerated version and approved actual costs. No invented prices or approvals. |
| 6. Export/recovery | Editable bilingual draft/final Word, content/hash-bound authorization, separate volumes, manual submission history; 15 fixture export pages visually checked; actual cloud metadata restored locally. | Hosted original-inclusive backup/restore and artifact download; actual Word field/pagination review. No buyer submission/payment. |
| 7. Operations/evaluation | Maintenance/cleanup, real heartbeat/usage/queue, AT01–AT30, increasing RFP fixtures and evaluation CLI. | Real object cleanup, authenticated mobile and Owner-labeled business-quality evaluation. Synthetic scores are not business accuracy. |

## Exact continuation point

1. Implementation changes, package checks, both queue migrations and final publication passed. Final application source `2fb0482fcadcbb7d8242960694f32ee97d9c5331` is on main; successful Pages run `39081884914`. API v15/worker v12 are unchanged. Six public files (HTML/index JS/CSS/source detail/opportunity detail/extraction worker) match the tested build byte-for-byte.
2. Real Ramallah assessment and repeat collection passed SQL and actual Owner browser verification. Newest history shows 10 notices processed, completed, Riyadh timestamps and six-hour enabled scheduling. No further repeat or model probe is needed for this release.
3. All currently runnable acceptance checks are recorded: 314 application tests, 28 isolated Chromium checks, hosted Owner journeys, actual metadata restore, real PDF extraction and hosted transport boundaries. Remaining acceptance depends on genuine business originals/decisions or unavailable hosted mobile/file-input capability; these remain unverified.
4. Full hosted proposal/export acceptance requires an eligible complete RFP plus its actual pricing/capacity decisions. The public 87-page PDF used for extraction contains contact/confidentiality content and was not silently approved/uploaded. The user supplies company details through their public website; prices are determined per tender scope and currency.
5. Existing credentials, content permissions, reservations and uncertainty must be preserved. No external invitation/email, purchase or bid submission is authorized.

## Settled decisions

- Connected-only builds; synthetic users/company claims/business data remain test fixtures only.
- Keep GitHub Pages, Supabase and separate frontend/backend packages.
- Owner supplied the company website; public sourced notes are allowed. No invented certifications, projects or rates.
- Selection → confirmed RFP → full linked proposal → scoped review/questions → regenerated version remains the workflow.
- Gemini Free is confirmed by the Owner. Do not require account login or invented quota-reset facts. Provider quotas/application budgets use persisted automatic retry; unknown generation usage never permits blind resend.
- Automatic optional-provider rotation is authorized independently of individual provider enable switches; real secrets/free-only configuration and exact content authorization remain required.
- Implementation, local tests, publication, hosted acceptance and output quality are different statuses.

## Mapping to the original specification

| Milestone | Current result |
| --- | --- |
| M1 local workspace | Superseded by connected-only production; local simulation is tests only. |
| M2 persistence | Auth/metadata verified in real session; original Storage journey pending. |
| M3 sources/queue | Four active real collectors, durable queue and scheduler; remaining portals manual. |
| M4 analysis/writing | Complete integrated pipeline; Gemini inference verified; actual proposal acceptance pending. |
| M5 export/operations | Export/recovery implemented and tested; actual metadata recovery and scheduler verified. |
| M6 evaluation | Local deterministic and partial hosted evidence recorded separately; no blanket quality acceptance. |

## Acceptance mapping: AT01–AT30

Local implementation and deterministic verification are recorded below. Hosted acceptance and business validation are separate; pending owner inputs are not marked passed. Earlier deployment and investigation checkpoints remain in Git history and the integration report.

| IDs | Implemented behavior | Local evidence | Remaining live acceptance |
| --- | --- | --- | --- |
| AT01–AT04 | Approved-source scheduling, pause/manual blockers, replay deduplication, immutable material-change snapshots and preserved human decisions. | collection.test.ts; collector.test.ts | Four public collectors and scheduled first collections verified; repeat after source revision recovery is being checked. |
| AT05–AT08 | Grounded weighted fit, uncertain/title-only routing, stable declined decisions under reassessment, unresolved ambiguous dates. | model.test.ts; generation.test.ts; operations.test.ts | Owner-labeled held-out data and live model. |
| AT09–AT10 | Exact original eligibility, content authorization, prompt-injection data boundary, no model tools or external business actions. | contentEligibility.test.ts; model.test.ts; modelPolicy.test.ts | Gemini activated; exact public notice/company evidence authorized. Full RFP eligibility remains separate. |
| AT11 | Auth membership/RLS, Owner-only commands, review authorship, private Storage design and historical non-authenticating actors. | database.test.ts; onboarding.test.ts; evidence.test.ts; operations.test.ts | Real signed-in role, object and cross-workspace journeys. |
| AT12–AT16 | Manual acquisition, confirmed RFP gate, extraction blockers, cited inventory, addendum invalidation, exact company-claim evidence and missing-input questions. | commercial.test.ts; evidence.test.ts; generation.test.ts; proposalPackages.test.ts | Representative real RFP and authenticated upload/generation. |
| AT17–AT18 | Server decimal calculations, markup/margin fixtures, zero/unknown rates, tax/period/FX/payment rules and delivery dependencies. | finance.test.ts; commercial.test.ts; proposalPackages.test.ts | Owner-supplied approved rates and assumptions. |
| AT19–AT21 | Version/evidence-bound approvals and export authorization, reviewed artifact hashes, editable bilingual Word and manual submission history. | commercial.test.ts; exportRenderer.test.ts; EXPORT_QA.md | Real Word field update and final artifact attestation; hosted account journey. |
| AT22–AT24 | Free-only ledger, reservation/unknown usage, rate/day caps, leases, cancellation, persisted split/repair checkpoints. | modelPolicy.test.ts; model.test.ts; generation.test.ts | Actual provider quota and hosted worker crash/timeout conditions. |
| AT25–AT27 | Hostname/DNS/redirect/size boundaries, actual hash/signature/parser caps, revisions and atomic audit/idempotency. | collector.test.ts; contentEligibility.test.ts; api.test.ts; evidence.test.ts | Authenticated hosted Storage and commands. |
| AT28 | Superseded demo requirement: connected-only login; no simulated persistence or query bypass. | connected.test.tsx; AuthPanel.test.tsx; app.test.tsx | Published mobile and signed-in persistence. |
| AT29 | Actual heartbeat/storage/queue/usage screen, 10-minute delayed signal and reference-checked cleanup. | operations.test.ts; worker handler tests | Hosted cron heartbeat verified; real original-object cleanup remains untested. |
| AT30 | Original-inclusive bounded backup, complete graph restore into clean matching schema, actor separation and approval reset. | recovery.test.ts; backupFormat.test.ts | 437 actual cloud metadata rows restored into isolated local PostgreSQL. Original-inclusive hosted restore remains untested. |

## Verification commands and maintenance

Run `npm run typecheck`, `npm test`, and `npm run build` in **both** `frontend/` and `backend/`. Each has its own lockfile. Normal checks use synthetic fixtures only and must not invoke real model APIs. The recovery, authorization, financial and evaluation checks are part of the backend suite, not extra counts to add to the total.

Read and update this checklist for every project change. Record implementation, test, source publication, hosted deployment and real-account acceptance separately. Record the exact Pages run after a source deployment completes. Preserve all stages and AT01–AT30 traceability. An unresolved connector operation, unavailable session or missing business input must remain explicit rather than being marked complete.


The real Ramallah notice assessment completed at **00:01:01 UTC / 03:01 Riyadh**, with one settled Gemini request: **798 input / 1,400 output tokens**. It returned needs_review, coverage 0 and no numeric fit score because the available title/company evidence was insufficient. This proves the actual collection → authorized evidence → model → recorded assessment path; it does not establish complete RFP coverage or business model accuracy.

### Browser mobile and collection-history follow-up — verified

Local Chromium with the isolated synthetic fixture exposed horizontal page overflow at 390px: an absolutely positioned screen-reader table label escaped its scroll container, and Knowledge tabs exceeded their flex parent. The table scroll wrapper now establishes a positioning context; tabs are bounded to the available width. All 24 Chromium desktop/mobile route and file/review/export checks passed with no JavaScript errors or external requests; original inputs and persisted Arabic answers were used. The downloaded DOCX is a valid package. These are isolated UI fixture results, not hosted Auth/Storage/model acceptance. This fixture uses no hosted accounts, objects, provider calls or fabricated cloud records.

Final hosted transport checks passed: health 200, anonymous bootstrap 401, missing/invalid worker POST credentials 401, forbidden origin 403. A preliminary GET to the worker correctly returned method-not-allowed 405; the credential tests use its supported POST. Security advisor categories/counts remain unchanged after both queue migrations (3 private-table INFO, 20 deliberate authenticated security-definer WARN, 1 disabled leaked-password-protection WARN).

Actual Owner read-only browser run `0fb194dd-c7b6-4c12-baad-63530b6ea156` confirmed the recorded insufficient-evidence assessment, pre-shortlist processing controls and reload persistence; Ramallah enabled/latest completed collection; verified IIH profile. It exposed missing processed counts in source history and browser-local timezone labels. The connected repository now attaches actual source-run counts (including zero; absent remains unknown), source jobs sort newest first, and dates explicitly use Riyadh. Source-count mapping regression passed for recorded 10, recorded zero, and absent counts. An additional regression prevents a superseded assessment from offering an invalid resume action. All 143 frontend tests/26 files and typecheck/build passed. Published as `2fb0482fcadcbb7d8242960694f32ee97d9c5331` in [Pages 39081884914](https://github.com/salahassi/tenders/actions/runs/39081884914).

Four additional Chromium checks passed for the local Reviewer fixture: review saving, attachment upload, opportunity creation and preference editing remain unavailable. These verify interface gates, with server authorization separately covered by the PostgreSQL/API integration tests. Actual Owner hosted browser run confirmed assessment/progress and profile reload persistence, plus newest successful Ramallah job and enabled source. No authenticated mobile or hosted original-byte upload is claimed.

Final Owner browser run `82e02232-0057-44fa-94f5-74dbf71ac366` saved the user-supplied company name for proposal branding and verified it after reload; other settings were preserved. It verified actual latest source history text “10 notices processed.”, “completed”, explicit Riyadh time and the enabled six-hour interval. Source job timestamps denote creation; SQL completion was 00:02:04 UTC. Final rendered mobile dashboard, knowledge and proposal viewport screenshots were visually inspected. No fixture entry point remains in source.

## October 18 software scope and assessment admission — deployed; acceptance in progress

Owner clarified software, digital transformation, AI and AI transformation services only, excluding hardware, and requires assessment before discoveries enter the inbox. Diagnosis: 34 of 35 notices had blocked `DATA_AUTHORIZATION_REQUIRED` assessment jobs; collection had no service-scope gate.

Implemented an audited Owner discovery policy, exact-public-snapshot authorization limited to selected providers, conservative Arabic/English physical-scope screening plus cited model scope decisions, and an RLS-preserving discovery progress view. The inbox admits current assessed notices only; active assessments, blockers and scope exclusions have separate tabs. Human bid decisions and original records are retained. Policy changes and notice-content changes queue reassessment; authorization-blocked jobs resume only after payload checks pass. Model quota/failover safeguards remain in force. New discovery notifications wait for assessment and exclude scope rejections. Operational discovery permission is not copied in business recovery; reconfigure it on the recovered workspace.

Local verification passed: **191 backend tests / 22 files**, **145 frontend tests / 27 files**, both typechecks/builds, and Deno checks of both Edge entry points. Tests cover exact public provenance, revocation/private-note rejection, Owner/revision/idempotency, RLS membership, restore reset, Arabic/English/mixed scope, real PostgreSQL worker-step completion without inference, stale notice replacement, and truthful UI admission/status.

The full migration hit a connector request-state timeout twice, with readback proving no application. The canonical `20261018075948_software_discovery_and_public_assessment.sql` was then applied in six consecutive hosted records: `20261018082905_software_discovery_policy_snapshot`, `20261018082921_software_public_notice_authorization`, `20261018082932_software_discovery_owner_configuration`, `20261018082941_software_discovery_progress_view`, `20261018082951_software_assessment_requeue`, `20261018083000_software_discovery_notifications_restore`. All six succeeded. Worker **v13** (15 files) and API **v16** (14 files) read back byte-for-byte identical to source; import map `deno.json` is explicit.

Automatic approval review rejected authorization for unconnected Qwen/Mistral/Groq because its accepted egress authorization covered Gemini only. The safe activation configures **Gemini only** for automatic exact-public-notice permission; the existing exact company-profile Gemini authorization remains. At **08:31:41 UTC**, software scope and automatic public assessment were activated via the audited Owner command, and all **35 existing notices** had real queued assessment jobs. All 35 human decisions remained `undecided`. Hosted completion, Pages and browser acceptance follow below; queued is not a completed assessment.

### Hosted scope acceptance and ambiguity follow-up

Initial release `87c24e722e7483bcebcc17d4a671ce5d5bea3850` published successfully in [Pages 39111832368](https://github.com/salahassi/tenders/actions/runs/39111832368); six served entry/review/settings/dashboard assets matched the local build exactly. Owner browser run `28bae1c2-fda5-4a20-bdcb-e45ff6cb6bfa` verified scope settings, Gemini-only automatic permission, queued assessment badges, physical exclusions with quotes, and reload persistence. It could not resize to 390px; no authenticated mobile acceptance is claimed. Its changing default-tab observation is not used as proof of an atomic assessment snapshot.

Actual Gemini assessed a public broadcasting-services notice as uncertain because its title does not establish whether software or operational services are required. Migration `20261018083848_require_confirmed_software_scope_for_inbox.sql` now requires explicit recorded `in_scope` under the software policy; ambiguous/mixed scope stays available under Needs attention. The repository also requires the progress view's exact assessment ID before admitting the item, covering a refresh where progress arrives before its assessment row. Tests assert uncertainty stays outside the inbox, confirmed software enters, and missing/mismatched assessment data cannot appear as assessed. **191 backend and 146 frontend tests**, both typechecks/builds, passed after these changes.

All seven deployed function bodies in the first canonical migration match their local MD5 hashes, and every function has an empty search path. Security advisory counts/categories remain unchanged: 3 private-table INFO, 20 intentional authenticated security-definer WARN, 1 pre-existing leaked-password-protection WARN. No new exposed security-definer view was introduced.

At the follow-up checkpoint, 22 original notices were assessed and 13 queued. Gemini identified the real software-license/information-security notice as in scope; its fit score correctly remains unknown because detailed RFP/company evidence is insufficient. No credential, qualification or probability of winning is inferred from scope eligibility. Final queue and browser checks follow below.


## October 18 notice details and model-only assessment — implementation under verification

The Owner demonstrated known submission/fee/bond facts being reported as missing. The Ramallah adapter had retained listing text only. The Owner subsequently required **no hardcoded assessments**. Keyword scope screening and exact-phrase exclusion shortcuts have been removed; every new scope/fit decision requires model inference and cited evidence. Previous rule results remain historical and are excluded from current admission until reassessed.

Implementation: a leased pre-assessment step reads the approved detail page and bounded public PDF attachments, retains exact collected text and page provenance, and supersedes the listing-only plan. Public page/attachment reads preserve both hostname allowlists, public-DNS/redirect checks, byte/page/text limits and public-only access. Contact blocks are minimized; restricted PDF pages are withheld, image-only/unread/limited pages explicitly recorded. This does not confirm an RFP package or authorize private files. Temporary detail errors persist automatic retry. Successful source polls prompt detail re-reading even when listing text is unchanged.

Published submission clauses are parsed separately from document purchase/opening dates; known local times resolve using the portal timezone, date-only notices retain unknown time. Closed notices leave the current inbox and remain reviewable without modifying human decisions. The model receives the actual evidence coverage and must distinguish known buyer requirements from unknown company proof.

Local evidence so far: Deno parsed the actual 27-page public licensing PDF; 24 eligible pages are available, 3 restricted pages withheld. The HTML includes the actual fee, bond, legal prerequisites and March 10 submission deadline. Technical hardware text is retained in the PDF evidence. Synthetic regressions cover parsing, purchase/submission separation, SSRF/redirect/stream caps, real PDF text/empty/restricted pages, leased persistence, retry, service-only mutation, human decisions and expiry. Full package checks and hosted deployment/browser acceptance are pending below; no hosted completion is claimed at this checkpoint.


Follow-up verification: **189 backend tests/23 files and 147 frontend tests/27 files**, both typechecks/builds and Deno entry checks passed. The new integrated Company Knowledge regression uses an actual local PostgreSQL snapshot containing a verified note plus an extracted company file; both exact-hash references reach classification. The UI names the cited note/file. No such test records were added to the hosted workspace, which currently contains one verified company note and no company files.

Hosted changes: four consecutive detail migrations (snapshot/context, leased completion, retry/refresh, model-only inbox) applied successfully; API v17 and worker v15 are active. Original private minute dispatch resumed after the schema/worker transition. The reviewed Najah document CDN is included in both source and deployment hostname allowlists, with an audit event. A real hosted Ramallah refresh retained 41,707 characters, public-PDF coverage and the 2026-03-10 09:00 UTC / 11:00 Hebron deadline; human decisions were preserved. Source re-evaluation continues; final source publication, readback and browser acceptance are pending at this checkpoint.


Hosted/browser follow-up: Pages source `d31c161ddbcd7e9612b32244626343d1c4e7491f` deployed successfully in run **39114795903**. Owner read-only browser run `d7bf7a40-622e-47c6-8821-e5284623316e` confirmed the Closed tab, actual 350 ILS fee, 20,000 ILS bond, March 10 submission date, 24/27 attachment pages and reload persistence. It observed a superseded plan during background refresh, not a completed fresh model assessment. Its zero Company Knowledge count referred to files; SQL confirms one verified enabled company note and zero files. Do not count this run as completed assessment acceptance.

The hosted run exposed GTD's ASP.NET form container: removing forms discarded the public detail body. The reader now removes controls only and retains the article, with a synthetic regression. Superseded notice-detail plans no longer offer an invalid resume action. Longer full notices exceeded the previous 20k input boundary; classification now allows up to 64k counted input tokens, while all other tasks remain at 20k. The storage/RPC checks match this bound. Existing daily request/input/output budgets, free-only policy, exact authorization, lease checks and unknown-usage protections are unchanged. Queue selection prioritizes unread details before fresh inference; saved remote GET continuations remain first. New DB integration regressions verify larger assessment reservation, rejection above 64k, unchanged 20k for other tasks and pending-detail priority.

Final local code checks for this follow-up: **192 backend tests/23 files, 149 frontend tests/27 files**, both typechecks/builds and Deno checks passed. Hosted API **v18** and worker **v17** include the fixes; three bounded-reservation/queue migrations applied successfully. Detail extraction reached 31/35 notices at this checkpoint; final model results and subsequent publication remain to be recorded.

All **35 notices** now have hydrated detail evidence. Pages `0c80ed96b1ddc30fe4697336e9527aa609c9fab0` completed in [run 39115853410](https://github.com/salahassi/tenders/actions/runs/39115853410); five served entry/review/detail/CSS assets matched the build. A fresh hosted Najah application/security-services assessment completed using exact quotations from the verified Company Knowledge note. It explicitly reports the image-only attachment as unread/OCR-required. This is actual note-to-model citation evidence; company-file coverage is verified by the local database fixture because no company files are uploaded in this workspace.

The subsequent hosted run exposed a settled response truncated at the previous 2,048-token classification output cap. Round-robin masked that measured output error with missing-provider slots, repeatedly retrieving the same completed response. Classification now reserves a bounded 6,144-token output allowance under the unchanged daily budget. After visiting alternatives, measured validation/truncation errors reach the existing single-repair path; an unsplittable classification gets one repair, then an explicit blocker. Unknown usage and in-progress request identity protections remain unchanged. New tests cover GET-only retrieval of the measured truncated result, visiting the missing slot, surfacing the real error and the persisted one-repair limit. Deployment and final checks follow below.

The bounded-output migration and worker v19/API v20 deployed. **194 backend tests** passed after an initial concurrent frontend/backend run exhausted test timing; suites are now executed sequentially. The unchanged frontend exposed a separate test setup race: the save test typed before its fixture workspace finished populating. It now waits for the loaded field value before editing; final full rerun follows.

A superseded Ramallah request was still recorded with unknown usage despite having a durable provider request ID. The new maintenance reconciliation retrieves one canceled/blocked request by **GET only**, verifies the identity and measured usage, and settles its original reservation. It never resends its content or publishes a canceled assessment. A five-minute claim throttle prevents concurrent/repeated polling storms; failed/expired/unmeasured results remain unknown. A service-role-only RPC and an integration regression cover cancellation, failed-GET throttling, exact measured settlement, no additional POST and no result publication.

Final local checks for the recovery changes: **195 backend tests/23 files and 149 frontend tests/27 files** passed, both package typechecks/builds and both Deno entry checks passed. Worker **v20** and API **v20** read back exactly matching all 30 bundled source files. Both bounded-repair and superseded-usage migrations applied successfully. The private minute scheduler remains enabled. Hosted maintenance already reconciled one canceled request from actual provider usage; target assessment/browser and source publication results follow.

Pages `ba2f9c9aaf66f6e29a8a7e35eacf7fcd7ec9d981` published successfully in [run 39116970434](https://github.com/salahassi/tenders/actions/runs/39116970434); CI checks also passed. The actual Ramallah assessment completed from the full notice/PDF and cited the Company Knowledge profile. It identified mixed software/hardware, the 20,000 ILS bond, municipal clearance, profession license, OEM authorization and prior-experience requirements; it no longer asks for the known submission deadline. All three canceled requests with durable IDs were reconciled from actual measured usage; the two older requests without IDs remain unknown.

Owner browser run `4ee2c11e-3d4d-4757-b53b-4e4b6185c454` verified Najah's completed assessment, company capability quotes, unread/OCR attachment warning and an inbox without unassessed entries. It timed out before Ramallah and failed to locate the note section below the file list; it incorrectly treated the workspace name as a knowledge record. SQL and source confirm one note. The Knowledge summary now shows a separate note count and a jump button to the existing note section to make notes discoverable independently of uploaded files.

The real model still assigned low factor ratings from absent company proof. The model instruction now explicitly requires null/unknown for missing or insufficient company proof and affirmative cited mismatch evidence for a low rating; no code assigns replacement ratings or invents a qualification. A follow-up actual assessment is required to verify this instruction; no result is claimed at this checkpoint.

The proof-quality instruction and note-count navigation passed **195 backend / 149 frontend tests**, both typechecks/builds and both Deno checks. API **v21** and worker **v21** are deployed. An audited Owner assessment request for the existing Ramallah notice was queued to verify unknown company prerequisites under the new instruction; human bid decisions and Company Knowledge content were not modified.

Pages `a9cf7a3880cd59fa465b2f58d8edaf7888bbe035` published successfully in [run 39117645057](https://github.com/salahassi/tenders/actions/runs/39117645057); served index/Knowledge/detail/main bundles match the build. Owner browser follow-up `6aa45ef3-ea9d-4e2f-9b1b-6ccade16c408` located the actual verified IIH note and confirmed the exact Company Knowledge source title/quote on Ramallah, 350 ILS fee, 20,000 ILS bond with 120-day validity, separate March 9 purchase/March 10 submission deadlines and persistence after reload. It displayed the prior assessment while the proof-quality follow-up was running; do not treat its old 0/4 prerequisite rating as acceptance of the newer instruction.

The follow-up model response failed citation validation and entered its single bounded repair. Citation comparison now tolerates canonical Unicode and whitespace/line-wrap differences only; it still requires unchanged source characters, source identity, company verification and supplied evidence. Regression checks accept PDF line wrapping but reject changed amounts, reversed wording and blank quotes. This does not prove the specific rejected response was merely whitespace, and no rejected result is being admitted by assumption.

Citation comparison verification passed: **196 backend tests/23 files**, backend typecheck/build and both Deno entry checks. The final frontend code remains the already-tested **149 tests/27 files** from the preceding release. Security advisor categories remain the existing private-table policy notices, intentional authenticated RPC warnings, and password-protection setting; the new reconciliation RPC is not exposed to authenticated clients.

Worker/API **v22** read back byte-identical to all deployed bundle files. Pages run `39118380393` stopped in the unchanged frontend rejection-save test, which has the same fixture-loading race as the success-save test: the initial workspace value arrived after the test cleared the field. Its setup now also waits for the loaded value before typing. This preserves the actual rejection/unsaved-input assertions; the test is not skipped and no timeout was weakened. The temporary queue delays used to prioritize acceptance were restored to their original schedules after the target's bounded repair started.


## October 18: z.ai and owner-selected model identities

User requested z.ai, confirmed both Groq/z.ai accounts are free without paid billing, and clarified that model names must come from secrets. Added the provider adapter, safe environment metadata, contracts, permissions, provider settings, and five-slot round robin. The z.ai endpoint/JSON/thinking parameters were checked against current official docs; pricing lists GLM-4.7-Flash as free, but no model name or ranking is hardcoded. New automatic tasks read the configured model even after it changes; existing remote requests remain identity checked. Groq/z.ai accept Owner-attested provider-managed quotas without invented expiry/balance. Account identity changes, budgets and exact per-provider content consent remain enforced. The schema accepts four-slot workers during rolling deployment. Local/hosted/browser verification follows below; no z.ai live success claimed yet.

The previous Ramallah proof-quality acceptance completed at 10:15 UTC: all four factors are null/unknown with literal Company Knowledge note citations and detailed notice/PDF requirements. Missing company proof no longer becomes an automatic low score. Known bond, fee and deadlines are present; no replacement ratings were applied by code. A read-only settings browser run confirmed round robin enabled but confused billing attestation with key presence; its claim that Groq has no API key is not reliable. Worker metadata remains the source for configuration diagnosis.

The isolated frontend fixture fix `534cedb9a546ddab61f223be846a1aeb75d7b0ce` passed Pages run [39118815958](https://github.com/salahassi/tenders/actions/runs/39118815958). This closes the previous CI failure independently of the new provider work.

Provider changes passed **202 backend tests/23 files and 150 frontend tests/27 files**, both typechecks/builds and both Deno entry checks. Migration `20261018102432_zai_free_provider` applied successfully. API/worker **v23** are ACTIVE; all 30 deployed source files match the bundle byte-for-byte. Health returns 200 and unauthenticated model metadata/worker calls return 401. Live worker metadata confirms Groq has configured model/account/key but lacked free attestation; the Owner-confirmed Groq provider-managed policy is now saved through the audited command. z.ai secrets are currently absent (explicit MODEL_NOT_CONFIGURED); no real z.ai call is claimed.

Automatic review rejected adding Groq/z.ai content consent because it requires explicit authorization to disclose the current Company Knowledge note to these destinations. A precise consent question is pending; the rejected transaction made no consent/discovery changes. The safe standalone Groq billing-policy save succeeded and cannot transmit company content without existing per-provider authorization. Private minute scheduling remains enabled.

The final z.ai adapter omits a forced thinking mode, leaving that optional capability to provider defaults so switching models does not inherit a model-specific toggle. The API model identifier is sent unchanged; unsupported/retired models still produce ordinary provider errors and failover rather than a local name-based rejection.

The Owner explicitly approved public notices and the exact current IIH Company Knowledge note for both Groq and z.ai. Audited discovery/content commands succeeded; readback confirms all three selected destinations (Gemini, Groq, z.ai). Future private files are not included. The final adapter leaves optional thinking to provider defaults. The full backend rerun had one stale test expectation for the removed toggle; corrected assertion verifies the toggle is absent, and all 25 model tests plus typecheck/build/Deno rechecks pass (remaining 177 tests passed in the full run).

Actual Groq connection probe `5b9fe749-bc65-4254-976e-f93db7b34963` succeeded at 10:30 UTC using the Owner-configured model from secrets. The provider returned valid ready JSON and measured 456 input / 12 output tokens; the reservation is settled. No company content was included. Any temporary scheduling changes used for this check were restored immediately. API/worker **v24** read back exactly matching all 30 bundled source files. Security-advisor categories are unchanged. Pages source `3a8398cceb3c64829265e522bbf284ea425670af` is currently running CI; final result/browser follows.

Pages [39119501516](https://github.com/salahassi/tenders/actions/runs/39119501516) passed for `3a8398cceb3c64829265e522bbf284ea425670af`; CI reran both complete suites, TypeScript checks, Deno and frontend build. The served index, entry, runtime and Settings assets match the local build byte-for-byte. Live grant readback confirms internal routing/reservation remain denied to browser roles and available to the service role. Scheduler/round robin are enabled and provider permissions persisted.

Browser acceptance `a1a1295a-3ae2-4ff1-b693-4da271b46c40` verified the new z.ai card, Groq configured identity/free policy, enabled five-provider rotation and reload persistence. Its report incorrectly says all discovery-provider boxes were checked; authoritative SQL confirms only Gemini, Groq and z.ai. It also exposed a real health RPC error after adding a second model profile: a scalar subquery selected multiple model_settings rows. The status function now uses EXISTS across enabled profiles or automatic routing. A database regression covers no providers, two providers, disabled profiles, and routing-only configuration. Deployment/verification follow.

The multi-provider health fix passed **203 backend tests/23 files**, backend typecheck/build. Its hosted migration applied successfully; the same authenticated Owner workspace_status RPC that reproduced the scalar-subquery error now returns health metrics, enabled model state and real usage. API/worker source is unchanged at v24; frontend remains the published build verified by 150 tests.

Hosted health migration version is `20261018103611_provider_pool_status`. Owner browser regression `9f793e02-eb26-4327-b2e1-25ea75b940f4` confirmed the database error is gone, Processing health metrics load, scheduler/model are enabled, and 25 actual calls are shown. Browser state agrees with the authenticated RPC. Security-advisor categories remain unchanged. Groq has a measured successful live connection; z.ai is still unconfigured because its server secrets have not been added. No claim of a live z.ai call or completion of all queued assessments is made.

Final source `df98de995e6d3c13017f9902af05ff1908aa180b` passed [Pages run 39119917337](https://github.com/salahassi/tenders/actions/runs/39119917337), including both complete suites (**203 backend / 150 frontend**), TypeScript, Deno, build and publication. This closes the provider addition and multi-provider status fix; only z.ai credentials/account metadata remain Owner-supplied before a real z.ai request can run.


## October 18: continuing Company Knowledge permission and saved free-account confirmation

The Owner clarified that real comparisons must receive the company expertise and details from Company Knowledge, including subsequently added files/notes, and questioned the FREE_ONLY secret. Added an explicit workspace setting for enabled, verified, current Company Knowledge with selected model providers; exact hashes, revoked-item precedence, Owner authority, tenant scope, source attribution and audit remain enforced. Policy-derived authorizations are distinguished from explicit one-off consent and stop being valid when the policy is disabled. Unsupported/unverified/expired/style evidence is not silently promoted into company proof. No blanket access to other file categories is granted.

Automatic routing now accepts persisted Owner free-account confirmations without model metadata or a FREE_ONLY secret. The existing secret remains an optional backward-compatible attestation; credentials alone still do not establish billing status. Restores clear routing confirmations. Classification now supplies all eligible company source text instead of silently limiting larger profiles to twelve keyword-selected excerpts; actual context/budget limits still apply before generation. Local/hosted/browser checks follow; no new runtime success is claimed at this checkpoint.

Permission-only changes now preserve evidence revisions and completed assessments; changes to company content or discovery scope still invalidate affected evidence/approvals. This avoids resubmitting unchanged evaluations merely because a provider or continuing permission was added. Regression coverage includes Owner-only updates, permission removal, explicit revocation precedence, future company-file/note eligibility, expired/style exclusion, restore resets, full company text after the old excerpt boundary, and saved free confirmation without secrets/profile.

The company-permission migration applied successfully to the hosted database before the Owner clarified that billing attestations should be removed altogether. The final implementation supersedes the temporary saved-free-confirmation UI: credentials select eligible providers, and FREE_ONLY secrets are no longer read. Added persisted provider order, priority/default and optional round robin, revision/Owner validation, automatic waiting/retry after exhausted rounds, and round-attempt counts that exclude background polling. Added integration coverage for ordered failover, provider recovery, missing credentials, invalid orders, and visible attempt/retry state. Existing quota, content authority, usage reconciliation and business-decision protections remain. Full final local suites, deployment and browser acceptance are pending below.

Final local verification passed **212 backend tests / 23 files** and **153 frontend tests / 28 files**, both TypeScript/build checks and Deno API/worker checks. The focused 23-test routing rerun additionally verifies persisted round counts and automatic recovery after provider failures. A new polling assertion will also run in CI. Initial test-fixture/SQL-precedence/TypeScript issues were corrected before deployment.

Hosted `company_knowledge_processing_policy` and `credential_model_routing` migrations applied successfully (the latter hosted version `20261018110020`). API and worker **v26** are ACTIVE, all 30 source files match the submitted bundle exactly, and health returns HTTP 200. The Owner-authorized continuing Company Knowledge policy is saved for Gemini, Groq and z.ai. Evidence revision remains 43 after the permission-only change, avoiding unnecessary reassessments. The internal authorization helper is not executable by browser roles. Routing is enabled in priority mode with the existing Gemini → Qwen → Mistral → Groq → z.ai order, now editable in Settings. Existing application daily limits are unchanged; some real jobs currently wait until their Riyadh midnight reset. No additional live z.ai request or completion of all queued assessments is claimed. Pages CI and browser acceptance follow.

Pages [39121667590](https://github.com/salahassi/tenders/actions/runs/39121667590) passed for `c72fc383ab97b6f46fc4d125c5b68105d6f0d369`, including all **212 backend / 153 frontend** tests, TypeScript, Deno, build and deployment. Security-advisor categories are unchanged. Minute scheduling is still active. Hosted Company Knowledge currently consists of one verified note and zero ready company files; future-file eligibility is covered by integration fixtures, not fabricated hosted uploads.

Browser run `16c27630-0740-44b1-a026-726b270c9414` changed Groq's order, saved and reloaded successfully; the stored routing revision/order corroborates that action. The run exhausted its time before restoring, so an audited Owner command restored the original five-provider order and priority strategy. Its report conflated Cloudflare's separate manual card with the five-item ordered list and reported the company checkbox unchecked despite persisted true policy. A focused read-only browser check follows to verify the live checkbox property and the actual pending-opportunity attempt/time display. No content permissions or application limits changed during the order test.

Focused browser acceptance `80053583-37d3-4391-849c-a94fd45ed5e5` passed: the real pending opportunity displays **Waiting for model quota**, **Attempts: 1**, and **19 Oct 2026, 00:00 Riyadh**. The Company Knowledge checkbox's live DOM `checked` property is **true**. The five-item ordered list is exactly Gemini → Qwen → Mistral → Groq → z.ai, matching authenticated SQL readback (routing revision 3, priority, enabled). No visible page errors occurred. This resolves the first browser report's checkbox/list ambiguity and completes hosted acceptance for attempts, order persistence and ongoing company evidence permission. Current quota waiting is an existing application daily ceiling, not a billing-attestation requirement or evidence of provider availability. The final documentation-only commit does not alter the tested/deployed source.


## October 18: durable model activity, targeted checks and clear waiting status

Implementation in progress: persistent provider attempts with measured versus reserved token counts, validation outcomes, duration, HTTP/request metadata, tenant-scoped opportunity/proposal links and newest-first pagination. Historical usage is labeled without inventing past validation success. Owner probe commands can target one provider without allowing another provider to satisfy the check. Processing health separates queued/running, quota waiting, automatic retries and actual blockers; jobs preserve waiting states. Current hosted 40 blocked is 28 quota-wait +12 blocked (7 input reduction,3 provider request rejection,2 uncertain connections). Local tests, deployment, actual z.ai probe and browser acceptance pending; no new hosted success claimed.


Local validation passed **217 backend tests / 23 files and 155 frontend tests / 29 files**, both TypeScript/build checks and Deno entry checks. Initial SQL argument ambiguity and OpenAPI generator type issues were corrected before deployment; the final HTTP filter/cursor regression also passed. Hosted model_activity_observability migration applied, API/worker **v27** ACTIVE. Targeted z.ai operational probe 61bcf094-b340-4cb5-897d-3754fe7f0e28 queued through the audited Owner command; result pending. Browser roles have read-only tenant-scoped telemetry. Deployment readback, Pages and browser acceptance follow.


Hosted readback confirms all 30 API/worker source files exactly match v27. Health HTTP 200 and security-advisor categories/counts are unchanged. Authenticated status now reports 28 quota waiting, 12 true blocked and 1 automatic retry (z.ai check); the 12 are 7 assessment input-reduction blockers and 5 old model probes. The 28 wait on application daily caps, not billing status. Owner changed routing order independently to Gemini→Groq→z.ai→Qwen→Mistral (revision 4) during this work; that change was preserved.

Real targeted z.ai probe used the supplied **GLM-4.7-Flash** verbatim. Attempts 1/2 returned **HTTP 429 / PROVIDER_QUOTA_WAIT**, durations 1639/1471 ms, provider request IDs captured. Measured input/output/thinking counts were not returned and remain null; conservative reservations are 2489 input / 256 output per attempt. The job automatically retries with increasing delay (round 2 next 11:42 UTC), without using another provider to claim z.ai success. No successful z.ai response is claimed.

Pages [39124052215](https://github.com/salahassi/tenders/actions/runs/39124052215) succeeded for `b112ae6dfd484a1af0c4568367ee37e31b0ae401`, rerunning both complete suites, TypeScript, Deno, build and publication. Published index/entry/runtime/CSS match the local build byte-for-byte. Read-only browser acceptance 9cf58cd3-b410-478e-8c51-a82e38408bb9 is in progress.


Final review identified a queued-probe race: disabling automatic routing could let a targeted check use the legacy manual Gemini path. Added a database guard and regression to preserve the requested provider identity across configuration changes. Full backend rerun and hosted guard migration pending. No UI or edge bundle changes.


The provider-identity guard passed all **218 backend tests / 23 files**, backend TypeScript/build, and its hosted migration applied successfully. Frontend/edge bundles are unchanged from the published build. Browser run 9cf58cd3-b410-478e-8c51-a82e38408bb9 verified real GLM-4.7-Flash attempts 1/2, HTTP 429, unknown measured tokens, round counts, request IDs and durations. It exhausted its execution budget before dashboard/link navigation, and its dropdown report read the first option rather than proving the live select value. A focused read-only follow-up a7f231be-b170-4707-b690-95a022050425 is checking dashboard reasons and live DOM selected value; that ambiguity remains pending. All 23 historical assessment log rows link to their real opportunities by authenticated database joins. No hosted proposal-generation run is claimed in this turn.


Final guard source `e4476290b9123633c78b957f5053ecbf8eac2af4` passed [Pages 39124739323](https://github.com/salahassi/tenders/actions/runs/39124739323), including both complete suites (**218 backend / 155 frontend**), TypeScript, Deno and publication. Hosted SQL confirms the guard is present and browser roles cannot start/finish telemetry. Security-advisor categories/counts remain unchanged. Unauthenticated model-activity and worker requests return 401.


Focused browser run `a7f231be-b170-4707-b690-95a022050425` verified the new dashboard separation and reason labels: at that snapshot 38 queued, 1 running, 0 quota waiting, 1 retry waiting and 5 needing attention (the old connection checks). Business data changed during acceptance, so the original screenshot's 28+12 counts are historical, not fixed expected totals. Minute dispatch responses at 11:52–11:54 UTC are HTTP 200 and process real job IDs; the z.ai check remains queued for retry behind other eligible work. Its next-attempt timestamp is earliest eligibility, not a guarantee of immediate service.

The browser agent again reported an All providers dropdown but omitted the live value; this conflicts with the filtered two-row z.ai data. Added a HashRouter regression asserting actual select.value=zai_free and selectedOptions[0].text=z.ai after loading; all 3 model-activity component tests, TypeScript/build pass. A strictly scoped follow-up `c0cacabd-ef9b-4c75-9cfc-23b212322f03` requests literal JavaScript output or explicit inability to execute, to avoid treating DOM-snapshot interpretation as evidence. No product code was changed based on the ambiguous report.


Final browser diagnostic `c0cacabd-ef9b-4c75-9cfc-23b212322f03` explicitly returned executed=false: TinyFish cannot execute the JavaScript needed to read select.value/selectedOptions. The earlier asserted DOM value is therefore unverified, not a reproduced product defect. The actual HashRouter DOM regression passes. Hosted model activity and health labels were visually verified; live filter DOM introspection and opportunity-link click-through were not completed by the browser tool. These remain verification limits, not claimed E2E passes.

Final local frontend suite passed **156 tests / 29 files**, plus TypeScript/build; backend remains **218 tests / 23 files**. Source `925a9d5ce40613a3713b9d16238f2c7c6086b2b2` passed [Pages 39125262449](https://github.com/salahassi/tenders/actions/runs/39125262449), rerunning both complete suites and publishing the unchanged runtime artifacts. API/worker remain v27 with exact source readback. Final documentation-only reconciliation follows; no additional provider success, completed backlog, resolved historical usage, or complete browser coverage is claimed.


## October 18: provider rejection diagnosis

Implementation: record structured provider error code/type and a normalized reason on each attempt; distinguish z.ai rate limiting, server overload and provider account errors without retaining response bodies, prompts or keys. HTTP 429 alone no longer implies exhausted quota in activity/health/job labels. Existing ordered failover, retry backoff, attempt counts and unknown-usage protections remain. Old logs stay unknown rather than backfilling guessed causes. Local tests, hosted migration/runtime publication and a new independent z.ai operational check are pending.

The first diagnostic release passed 224 backend tests/23 files, both TypeScript/build checks and Deno. All 157 frontend tests/29 files passed in an isolated run: an incomplete new fixture was corrected, and the concurrent run hit the existing UI-journey timing limit; no assertions/timeouts were weakened. The hosted diagnostic migration and API/worker v28 are active; all 30 files match source exactly. Browser roles cannot finish attempts and model_activity remains security_invoker=true; security-advisor categories/counts are unchanged.

A new independent targeted z.ai check on v28 returned no HTTP response before the automatic 20-second timeout (20,214 ms); usage is unknown. It does not explain the historical 429 responses. The older inconclusive check was canceled through an audited Owner command, retaining all attempts/usage. Single-provider operational probes now receive a bounded 90-second timeout, independent of model name; multi-provider work keeps its existing per-provider budget. Final regression/deployment and longer live check pending.

Final local checks passed **225 backend tests/23 files and 157 frontend tests/29 files**, both TypeScript/build checks and Deno. The extra regression receives a valid single-provider result after 21 seconds. API/worker v29 are deployed with the 90-second diagnostic budget. The inconclusive 20-second probe was retired through an audited command without resolving or deleting its unknown usage; a new independent targeted check is queued. Pages publication and actual provider result follow.

The longer-budget v29 check received **HTTP 200** from the supplied GLM model in 4,110 ms, reporting 494 input/256 output tokens. Output hit the diagnostic's 256-token ceiling, so validation correctly recorded MODEL_OUTPUT_TRUNCATED instead of success. This proves an actual z.ai response, but does not establish the cause of older 429s. The provider-neutral connection-probe cap is now 1,024 output tokens to include a modest reasoning allowance; reservation and wire request share this cap. No model name, thinking mode, billing or business-generation limit was changed. Final checks and automatic retry pending.

A subsequent real request returned **HTTP 429 with z.ai code 1305 (overloaded)**, now durably recorded with the request ID and attempt history. This identifies the new rejection as provider-side overload, not proof of consumed account quota or a billing requirement. Historical 429s retain unknown causes. The targeted check remains in automatic retry. The diagnostic UI/source b91fe106134217a43b4fa8e1a1bbd84e5037a4d8 passed Pages [39134595160](https://github.com/salahassi/tenders/actions/runs/39134595160). Final 1,024-token cap passed all 225 backend tests and TypeScript/build/Deno after updating two fixed probe-budget expectations; frontend remains the tested 157-test bundle. API/worker v30 deployed; source readback, next live attempt and focused browser acceptance follow.

Hosted v30 readback matches all 30 source files exactly. The new diagnostic recorded two actual 429/1305 overload responses with request IDs and retry rounds; output counts remain unknown when the provider does not report them. Next scheduled attempt retains normal backoff. Focused real-browser run `85e95c6a-ae25-40ed-8c34-c396eb87ed08` verified the historical-429 explanation, expandable Provider error code/type fields as Not recorded, HTTP status, request ID and round number, with unknown tokens preserved. This was read-only; its report's canceled label refers to the old job, not a successful attempt. The published index, Jobs and OperationsPanel assets match the tested frontend byte-for-byte. New known-reason rendering is covered by component/integration tests and the hosted row; no additional live browser check of that newer row is claimed.

Final source `a64bb25092e9a12613ed365a04eb2e1e1e84a097` passed [Pages 39135032795](https://github.com/salahassi/tenders/actions/runs/39135032795), including both full suites (225 backend/157 frontend), TypeScript, Deno, build and publication. Runtime remains v30 with exact source readback. The operational result is a confirmed current z.ai overload (1305), with automatic retry and durable attempts; successful completion under the larger probe cap is not yet claimed. The change does not alter provider order, credentials, application daily ceilings, company evidence policy, or historical unknown usage. This final reconciliation is documentation only.

## October 18: OpenAI and Claude support

Implemented native OpenAI Responses and Anthropic Messages adapters, owner-supplied model names, structured request/error metadata and measured token usage (including Claude cache-read/cache-creation input). Added OpenAI/Claude to credentials, provider policies, ordered failover, targeted probes, company/discovery permission controls and activity filters. Existing provider order is preserved with the new providers appended; older five-provider clients/workers remain compatible during rollout. No model names, account billing attestations or keys are fabricated. Missing credentials skip without network calls.

Local validation passed **235 backend tests / 23 files and 159 frontend tests / 29 files**, both TypeScript/build checks and Deno API/worker checks. Integration coverage exercises each native adapter, OpenAI 429 → Claude success, missing credentials, measured cache/reasoning usage, incomplete output and request metadata. These use fixtures; no real OpenAI/Claude inference is claimed.

Canonical migration `20261018142401_openai_claude_providers.sql` applied as hosted `20261018144138`. API/worker **v31** are ACTIVE and all 30 files match submitted source exactly. Health returns HTTP 200; anonymous model activity returns 401. The private routing implementation remains inaccessible to browser/service roles (the existing service wrapper remains the entrypoint). Security-advisor categories/counts are unchanged. Hosted priority order preserves Gemini → Groq → z.ai → Qwen → Mistral and appends OpenAI → Claude, routing revision 5.

Automatic approval review rejected adding OpenAI/Claude to the current Company Knowledge sharing policy because prior explicit destination consent named Groq/z.ai. No workaround was attempted: the hosted policy remains unchanged at workspace revision 7 / evidence revision 45. The new sharing controls are implemented and tested; enabling this workspace policy awaits explicit Owner approval. UI publication and real-browser setup inspection follow.

Source `9356d48a8bae192762040799894ca6c879b9f84b` passed [Pages 39137277869](https://github.com/salahassi/tenders/actions/runs/39137277869), including both complete suites, TypeScript, Deno, build and publication. Published index and Settings bundle match the local build byte-for-byte. Anonymous worker POST returns 401; minute scheduling remains active. The service routing wrapper is executable by service_role and not authenticated, while its internal implementation remains private.

Read-only browser run `2fde88fd-1a66-41f6-81a2-51485b0eb5bc` reported both new provider cards and targeted-check buttons visible in the authenticated Settings page. Its provider-order report conflated card order with saved routing order and some older provider metadata appeared shifted; those details are not accepted as proof. Hosted readback confirms the preserved priority order at revision 5. The new cards were reported unconfigured, but no independent server-secret metadata read or actual OpenAI/Claude request was performed. Provider inference and full live configuration E2E remain unverified pending credentials and explicit sharing-policy approval; native adapter/failover behavior is covered by integration fixtures. No hosted business data or company policy changed during browser verification. Final reconciliation is documentation only.

The Owner subsequently approved OpenAI/Claude data processing and confirmed no API keys are available. The audited `discovery.configure` command now includes both providers for public notices and eligible current/future Company Knowledge. Hosted verification confirms workspace revision 8, unchanged evidence revision 45, one policy audit event, enabled automatic routing and unchanged order/revision 5. The earlier approval block is resolved. A focused local rerun passed **12 adapter/routing tests across 2 files**, including skipping missing configuration without external requests, targeted-provider identity and OpenAI-to-Claude failover. These are fixture-based integration checks, not authenticated provider inference. No new external model call, runtime change or deployment was needed; actual OpenAI/Claude results remain unverified until API keys and supplied model names are configured.

## October 18: settings organization and provider configuration review

Reviewed Settings against its commands, environment parsing, routing SQL, content policy, maintenance and source scheduling. Confirmed confusing duplicate model identity inputs, an ineffective individual enabled toggle during automatic routing, conflicting static failover ranks, repeated per-item/provider buttons, and stale free-only/retention copy. The displayed workspace polling interval is a default for newly added sources, not a reschedule command for existing sources. Browser audit `2a6008f6-3574-4cf7-96d5-a47e1c34a355` corroborated page density; its claim of two order-save buttons conflicts with source and is not accepted as fact.

Implementation in progress: six navigable sections that load on first visit and retain drafts; one ordered automatic-provider card per provider with read-only server identity, credential presence and a targeted probe; separate data-sharing policy, compact searchable individual content review, and usage reconciliation under operations. Legacy manual routing and advanced ceilings remain explicitly labeled. Individual permission-record absence no longer claims content is forbidden when a workspace policy may apply. Save-one-provider preserves other drafts. No secrets, hosted provider order, consent, quotas, schema, evaluation logic or worker behavior are being changed. Local tests and published/browser verification pending.

Local verification passed **165 frontend tests / 31 files and 235 backend tests / 23 files**, both TypeScript/build checks. The first concurrent full run timed out in an existing unrelated navigation journey; the complete isolated rerun passed without weakening assertions or timeouts. Focused new coverage checks provider-specific probes, missing keys, server-identity review, order/strategy persistence, failed-save preservation, independent drafts, role gates, exact-hash permissions and measured zero usage. Local Chromium acceptance passed **14 checks** at desktop (1440px) and mobile (390px): all six sections fit without horizontal overflow, a single order-save action and seven automatic cards, disabled unconfigured probes, order/strategy save and reload, and an Arabic draft retained across sections. These use isolated synthetic fixtures with zero external requests. Temporary browser files were removed from production source. Hosted readback preserves workspace revision 8 / evidence 45 / routing revision 5 and existing company policy. Publication and authenticated browser acceptance pending.

Source `98d6fa34ab13f1f70cae1d94950b089b8c1cf160` passed [Pages 39146970629](https://github.com/salahassi/tenders/actions/runs/39146970629), rerunning all **400 tests**, TypeScript, Deno, build and deployment. Published index, Settings script and admin stylesheet match the local build byte-for-byte. API/worker remain the previously verified **v31**; this release changes the frontend only.

Authenticated browser run `09be773a-c75c-4ec5-a2a6-2bd443e27c07` confirmed six-section navigation and the assessment/data heading, but sampled the initial model-loading state and did not finish operations navigation. Focused follow-up `400b9f88-f193-471f-9af5-ba1c8ffbea62` waited and confirmed model settings load successfully with no visible errors, automatic priority routing and read-only model information. It distinguished items below the viewport from missing DOM elements; full live scrolling/count and operations acceptance are not claimed. The complete layout/save/reload journeys are covered by the local Chromium checks above. No live provider probe or hosted settings mutation was performed. Final reconciliation is documentation only.


## October 18: Cloudflare in automatic routing

The Owner identified Cloudflare's exclusion from the automatic provider list. Implementation includes it in priority/round robin, saved order, targeted probes, per-attempt telemetry and credential-based selection. The migration appends Cloudflare while preserving the existing strategy and relative order, and accepts older four/five/seven-slot workers and five/seven-provider clients during publication. The separate legacy-only card is removed; incomplete credentials skip without network calls. Existing account identity, content permissions, application budgets and unknown-usage protections remain. Local checks, hosted migration/runtime publication and browser verification are pending; no real Cloudflare inference is claimed.

Local verification passed **239 backend tests / 23 files and 166 frontend tests / 31 files**, both package TypeScript/build checks and Deno API/worker checks. The concurrent suite run timed out in the existing frontend navigation journey and caused two follow-on failures; the complete isolated frontend rerun passed without changing assertions or timeouts. Cloudflare coverage includes native endpoint/account/model identity, a targeted successful probe with measured usage, HTTP 429 failover, missing account skips, eight-provider rotation and seven-slot worker compatibility. Local Chromium passed **15 checks** across desktop/mobile, including eight cards, Cloudflare reordering/save/reload and the provider-specific probe action. All browser data was synthetic and local, with zero external requests; the temporary entry was removed.

Hosted deployment is **blocked, not complete**. Two Supabase `apply_migration` calls returned `McpServerError: Invalid or expired requestState`. Read-only verification after both confirms zero migration history entries and the unchanged seven-provider round-robin order at revision 6. The CLI alternative reports `AccessTokenRequiredError`; no credentials were read or fabricated. API/worker and production Pages were not changed. Source is prepared for a draft branch/PR; do not publish the frontend or eight-slot worker until the database migration succeeds. Deploy API, worker and frontend afterwards, then verify source readback and hosted behavior. No real Cloudflare inference or hosted browser acceptance is claimed.


The follow-up resolved publication by replacing the repeated full-function migration text with an atomic, guarded migration. It checks the exact existing function-body SHA-256 values, changes only routing/probe provider lists and bounds, and verifies that the resulting bodies exactly match the previously tested definitions. The complete **239-test backend suite**, TypeScript and build passed again; frontend code and its **166 tests / 15 local Chromium checks** are unchanged. The shorter request succeeded; the earlier error's internal cause is not independently established. No plugin permission changes or new credentials were needed.

Canonical `20261018172905_cloudflare_automatic_routing.sql` applied as hosted `20261018180805`. API and worker **v32** are ACTIVE. Hosted routing is enabled, round robin, revision 7, with Gemini → Groq → z.ai → Qwen → Mistral → OpenAI → Claude → Cloudflare. Current content-sharing policy is unchanged. The private helper remains inaccessible to browser roles, and the service wrapper remains callable by service_role. Source readback, Pages publication and final acceptance follow.


Cloudflare release source `f93b50b30c7de96a062395b573884535a35db85f` passed [Pages 39152956954](https://github.com/salahassi/tenders/actions/runs/39152956954), including all **405 tests**, TypeScript, Deno, build and deployment. Published index, Settings script and admin stylesheet match the local build byte-for-byte. API/worker **v32** readback matches all 30 submitted files exactly; health returns HTTP 200 and anonymous model activity returns 401. Security-advisor categories/counts remain unchanged.

Read-only authenticated browser run `e88df3c8-b720-4f62-b9ed-1d15b1f4e9d5` completed and reported the eight-provider saved order, Cloudflare at position 8, its targeted-check button present, and absence of the old Legacy manual fallback section. Cloudflare is currently reported **Not configured**. The report did not independently establish the button's live disabled property, so that detail remains covered by local UI tests rather than claimed hosted DOM verification. No settings were changed by the browser, no live Cloudflare inference was performed, and data-sharing permissions are unchanged. The Supabase publication blocker is resolved; final reconciliation is documentation only.


## October 18: configurable company service scope

Implementation in progress: replace the embedded business-sector preset with Company Knowledge, owner keywords, or both. Interest/exclusion terms are editable configuration; the model interprets procurement context and cites the chosen scope basis. Keywords cannot prove company expertise. Verified company files/notes remain the sole source of capability evidence. Scope/keyword changes invalidate dependent assessments and approvals and queue reassessment; sharing-only changes preserve evidence revisions. Restore resets automatic sharing. No provider order or destination permissions change. Local tests, runtime/database publication, Pages and browser verification pending.

The backend implementation passed **245 tests / 24 files**, TypeScript/build and Deno API/worker checks. Coverage includes Arabic/custom non-technology scope, Company Knowledge quotation validation, configured keyword citations, unknown capability without company evidence, keyword-change revision/reassessment, role/revision/idempotency boundaries and unchanged consent behavior. Frontend full tests, local browser acceptance and publication remain pending.

Frontend TypeScript/build and **169 tests / 31 files** passed. The unrestricted local test run hit several existing 5-second UI timing limits; the complete rerun with two workers passed without changing assertions or timeouts. Local Chromium passed **9 checks**: all three scope modes at desktop/mobile widths, Arabic/English normalization, empty/conflicting-keyword validation, save/reload and draft preservation across sections. These used isolated synthetic fixtures and made zero external requests; the temporary entry was removed. An additional adapter test confirms invalid scope citations record a failed attempt with measured usage and fail over to the next provider. Final backend regression and publication pending.

Final backend regression passed **246 tests / 24 files**, TypeScript/build and Deno. Supabase applied the schema migration, then rejected the full command-definition request with `Invalid or expired requestState`; readback confirmed it had not changed the function. Replaced that migration with a 1,996-byte atomic update guarded by exact before/after function-body hashes, producing the identical tested definition. The focused 12-test discovery integration suite passed against all migrations, and the compact request succeeded. No permission/credential changes were needed.

All three scope migrations are applied. API/worker **v33** are ACTIVE and all **31 files** match submitted source exactly. The hosted command hash matches the tested definition, and opportunity_discovery retains security_invoker=true. The audited Owner command selected combined scope using the Owner's previously stated interests and exclusion; these are stored workspace configuration, not repository business constants. Workspace revision 10 / evidence revision 54; automatic notice/company sharing destinations and provider routing are unchanged. Reassessment has been requested; Pages publication and hosted queue/asset acceptance follow.

Source `7ffed4e3bb8f11a02e1ee21ac67359991b0f50a8` passed [Pages 39169516745](https://github.com/salahassi/tenders/actions/runs/39169516745), including all **415 tests**, TypeScript, Deno, build and publication. The published index, Settings/Review bundles and admin stylesheet match the tested build byte-for-byte. Health returns 200; anonymous model activity and worker POST return 401. Hosted migration versions are `20261018211845`, `20261018214725` and `20261018214740`. The earlier Supabase request-state blocker is resolved.

Hosted readback confirms one audited combined-scope update and 38 new assessment plans carrying the exact saved scope snapshot at evidence revision 54. At verification, 37 jobs were queued and one was in `MODEL_DAILY_QUOTA_WAIT`, next retry `2026-10-19T21:00:00Z`; no newly completed live assessment is claimed. Existing application/provider daily ceilings were preserved. Real model completion waits for available budget. Browser save/reload coverage is the local Chromium acceptance described above; no new authenticated hosted browser session is claimed. This final reconciliation is documentation only.


## October 19 (Riyadh): stalled discoveries and rejected-request reservations

Diagnosis: 38 collected opportunities, all waiting on the configured daily output budget; 24 are closed and 14 remain open. Four automatic sources last polled successfully on their six-hour schedule; the other 31 directory entries require collectors and are not active feeds. The budget sums kept full reservations for proven HTTP 429 generation rejections even though their ledger state was settled. This contributed to a daily stop despite much smaller reported usage.

Implementation: release only the internal token reservation when durable telemetry proves an initial generation HTTP 429, with matching usage/workspace/job/provider and no accepted remote request. Measured values remain unchanged (including null), calls still count, and missing telemetry, unknown usage, poll failures and accepted Gemini requests retain reservations. Admission limits and health totals use the same accounting; affected daily-wait jobs are eligible for a budget recheck. No source activation, content permission, provider order, hard ceiling or evidence changes. Tests and hosted verification pending.

Local validation passed **248 backend tests / 24 files and 169 frontend tests / 31 files**, both TypeScript/build checks. Tests prove failover under a one-request output budget after a confirmed initial 429, retain null measured values, and preserve reservations for missing telemetry, HTTP 503, retrieval/poll errors, accepted remote requests and unknown states. The existing per-workspace call ceiling and provider content authorization checks still apply.

The accounting migration is deployed. Hosted output-budget accounting changed from 47,353 to 33,017 by releasing four confirmed initial-rejection reservations; reported output remains 2,297 and both unknown-state records are unchanged. Fourteen non-expired assessment jobs were made eligible to recheck their budgets immediately; expired work keeps its existing schedule. The security advisor retains the same three finding categories. API/worker remain v33; no Edge code or frontend code changed. A fresh audited collection round was queued on the four already approved automatic sources; actual completion and any newly collected notices are tracked separately. Source publication and final hosted observations pending.

Source `fecac65139f55136006dc80df3ec1296ef9023bc` passed [Pages 39173073672](https://github.com/salahassi/tenders/actions/runs/39173073672), including all **417 tests**, TypeScript, Deno, build and publication. Canonical migration `20261018223214_rejected_request_reservation_accounting.sql` is applied as hosted `20261018223646`. Authenticated health readback uses the corrected accounting. Existing unknown usage remains unresolved; this correction does not convert unreported usage into measured zeroes. Browser behavior is unchanged and no new hosted browser E2E is claimed.

Final hosted observation at **2026-10-19 01:45 Riyadh**: all four audited collection jobs succeeded (Jordan processed 7 notices, Najah 19, IsDB 0, Ramallah 10); no new opportunity was inserted and the total remains 38. Processed counts include existing notices and are not discovery-growth counts. Twenty-four opportunities are expired and fourteen remain open. All fourteen open assessment jobs are eligible now: eleven queued and three retaining the daily-wait label until the worker rechecks them. Source polling refreshes notice-detail evidence first; no new model request or completed current assessment is claimed at this observation. Minute scheduling remains active. Additional bounded dispatcher invocations used the existing worker, lease and budget checks without changing cron frequency. The 31 manual/proposed directory entries remain unconnected; expanding collector coverage is separate remaining work. Final reconciliation is documentation only.

## October 19: autonomous processing and notification preferences

The Owner requires unattended collection, immediate assessment scheduling, provider failover, retry recovery and email alerts/digests with preferences. Automatic routing no longer uses internal daily call/token admission ceilings, remote token-count requests, stored account-identity approval or the legacy plan-call cap. Actual reported usage remains logged, including unknown values. Manual policies, content authorization, evidence validation and active remote-request protections remain. Unknown duplicate requests have a bounded 15-minute cooldown, extended by recorded remote deadlines.

Transient failed rounds and collection failures retry after 1, 2 and 4 minutes, then hourly; finite provider retry times are respected. Failure counts are separate from worker polling attempts. A persistent failure generates one deduplicated alert after four failures; irrecoverable configuration/evidence blockers alert immediately. Source completion schedules assessment refresh immediately. SMTP failures cannot prevent the worker from claiming processing jobs.

Per-user Notifications preferences support failure alerts and review digests every 6/12/24/48/168 hours, in Arabic or English. Digests count current eligible discoveries and proposals; empty queues do not send. Generic SMTP uses server Secrets, verified current account recipients, TLS/STARTTLS, a durable outbox, current membership/preferences checks and bounded delivery retries. Accepted SMTP delivery is distinct from inbox receipt; uncertain acceptance is recorded without silent resending. Secrets and attachments do not enter emails or diagnostics. Restore pauses notification delivery. Eligible terminal outbox records follow workspace retention; unconfirmed records remain.

Local verification passed **262 backend tests / 25 files and 174 frontend tests / 32 files**, TypeScript/build checks and Deno entry checks. Local Chromium passed **8 checks** at 1440px and 390px: saved opt-in gating, preference save/reload, draft retention, test-queue feedback, no automatic token-ceiling controls and responsive layouts. These used isolated synthetic fixtures with zero external requests; the temporary entry was removed. The final SMTP sender-format diagnostic follow-up passed the complete backend regression; no authenticated hosted browser acceptance is claimed.

The automation migration applied as `20261019092629`. Two requests for the combined notification migration returned `Invalid or expired requestState`; readbacks confirmed no objects/history were created. Splitting the exact unchanged SQL into schema, commands and delivery-worker transactions resolved the tool failure. Hosted versions are `20261019100822`, `20261019100842` and `20261019100913`; the split-migration notification integration suite passed all 13 tests. API/worker v38 are ACTIVE. The 33 reachable files returned by deployment match submitted source; the bundler omits unused shared files. RLS and worker-only RPC privileges were verified. Advisor categories remain the same: three private no-policy tables, 22 authenticated security-definer findings (including authorized user RPCs), and leaked-password protection.

The audited Owner preference command enabled Arabic failure alerts and daily review reminders at revision 1. SMTP diagnosis identifies only APP_SMTP_FROM as invalid. The Owner confirmed its value was the display name TenderDesk without an email address. Standard display-name-plus-address syntax is supported; the Owner was asked to supply a verified sender address in Secrets. No successful mail delivery is claimed yet. Hosted model logs demonstrate actual Gemini/Groq/z.ai attempts and failover followed by retry_wait with failure_count; provider quota/network errors still occur. Historical failed manual probes remain historical. The four approved automatic collectors continue on their schedule; 31 manual/proposed directory entries are not newly connected by this release. Pages publication, final sender-format runtime readback and actual SMTP test remain pending.

Source `151b8ce4a45d36598dd727c8d66c8e781d3a2c88` passed [Pages 39236344268](https://github.com/salahassi/tenders/actions/runs/39236344268), including all 436 tests, TypeScript, Deno, build and publication. Published index, Settings bundle and admin stylesheet match the local build byte-for-byte. Health returns 200; anonymous notification settings and worker requests return 401. Two actual assessment jobs succeeded via Groq after the automation migration, including one with a previous failed round; remaining provider-side quota/network errors continue through the retry policy.

The worker now reports SMTP configuration ready after the sender setting changed, but the first actual Owner test was rejected by the SMTP server (SMTP_REJECTED); it is not recorded as delivered. A follow-up adds predefined sender-domain/test-recipient rejection codes and safe SMTP response-code/command diagnostics without raw server responses, addresses or credentials. API/worker v40 are ACTIVE; a new test will distinguish the account/sender restriction. No successful SMTP acceptance or inbox receipt is claimed at this checkpoint.

The SMTP diagnostic follow-up passed **263 backend tests / 25 files**, including 14 notification integration tests, plus TypeScript/build and Deno checks. Frontend remains at **174 passing tests / 32 files** with unchanged published assets. Final source/runtime reconciliation and the second real SMTP test are pending.

Final release `1dd129f2d65d799473b9599d02b1fa68a603e014` passed [Pages 39236879731](https://github.com/salahassi/tenders/actions/runs/39236879731), including all **437 tests**, TypeScript, Deno, build and deployment. API/worker **v40** readback matches all **33 reachable files** exactly. The frontend is unchanged from the byte-verified published assets above. Code, migrations and publication are complete; no authenticated hosted browser session is claimed (the available browser profiles have no recorded signed-in sites).

The second real Owner email test reached SMTP and was explicitly rejected with **SMTP_SENDER_DOMAIN_UNVERIFIED**. No email was accepted or claimed delivered. The remaining external setup is verifying the sender domain in Resend using its required DNS records, then retrying the test. User preferences remain enabled: failure alerts and daily Arabic review reminders. Actual hosted processing has completed two assessments via Groq; queued work and temporary provider failures remain under automatic scheduling/retry. Four approved collectors remain automatic; the 31 unconnected directory entries remain separate scope. Final documentation reconciliation only; no secret values or customer content are committed.


## October 19: successful Resend SMTP sandbox test

The Owner selected testing only, confirmed that the TenderDesk and Resend account email addresses match, and saved the Resend sandbox sender in Supabase Secrets. One new idempotent `notification.test` command was queued for the verified Owner account and processed through the existing dispatcher, durable outbox and generic SMTP worker. Delivery `4f78ae43-fe65-4aa2-9591-ea8f1773764c` reached **sent** in **one attempt**, with no error and a recorded message identifier, at **2026-10-19 13:30:49 Riyadh** (`10:30:49Z`). This proves real SMTP acceptance by Resend; the Owner subsequently confirmed actual inbox receipt ("وصل").

No application code, schema, recipient, preference, provider-routing or cron change was needed. No duplicate test was submitted. The Resend sandbox permits delivery only to the account-associated email; arbitrary production recipients still require a verified sender domain. This documentation-only follow-up preserves the prior 437-test release evidence; no unchanged code tests were rerun.


## October 19: seeded, database-owned source extraction

Source configuration stage: implementation and backend deployment complete; frontend publication and live collection verification pending. Audited all 35 hosted sources: all are seed-backed (35 source.catalog.seed events). Removed four institution-specific runtime registries/branches and fixed frontend institutional/country choices. Seed profiles now contain source URL, buyer, timezone, listing/detail selectors, labels and description templates. Workers load profiles from source database rows; new sources using supported layouts need configuration rather than a named code branch. API validates the declarative profile and collection URL. Collection permissions and generic safety limits remain enforced.

Explicit administrative seed backfill applied to four unchanged approved collectors; replay yielded exactly four extraction seed audit events, no duplicates. Readback confirms only extraction plus revision changed: Najah/GTD/IsDB 3→4, Ramallah 5→6. All 35 identities, URLs, approval states, permitted hosts and schedules are preserved. The other 31 manual/proposed entries remain unconnected. No schema change, permission grant or new source activation occurred.

Local backend: **266 tests / 25 files** passed, TypeScript/build and Deno API/worker checks passed. Added configuration-driven unknown-site listing/detail tests and database backfill/replay tests including owner-edited profile and URL preservation. Local Chromium at 1440px/390px passed profile edit/save/reload, database-derived new-country filtering and generic adapter selection with no page errors or external requests. This was an isolated synthetic browser fixture removed before the production build; no authenticated hosted browser acceptance is claimed. Frontend **174 tests / 32 files**, TypeScript and production build passed.

API and worker **v42 ACTIVE**, readback matches all **33 reachable files** exactly. Three actual approved source collections were administratively queued with explicit verification audit events; the fourth already had a current-revision scheduled job and was not duplicated. Results pending. No secrets or private company content were read or committed. Release source/workflow reconciliation pending.


Release `a5d0c5f7bb9d33e2c75e186a74e46084aeb05e2b` passed [Pages 39240778218](https://github.com/salahassi/tenders/actions/runs/39240778218): all **440 tests**, TypeScript, Deno, production build and publication. Published index, Sources and SourceDetail bundles match the local build byte-for-byte. API health returns 200; anonymous sources and worker access return 401. Code, seed backfill, runtime and frontend deployment are complete.

Fetched the four real public listing pages (HTTP 200) and ran the production parser locally using extraction profiles read back from hosted database rows: Najah **19**, Ramallah **10**, GTD **7**, IsDB **0** currently open records (closed notices skipped). These are parsed listing counts, not newly ingested discoveries. The cloud workspace's direct Node collector could not validate proxied DNS destinations; validation used bounded proxy HTTP retrieval followed by the unchanged production parser, without weakening production SSRF checks. Hosted scheduled verification jobs remain queued behind existing assessment work at this checkpoint; no successful post-deployment hosted collection completion or authenticated hosted browser E2E is claimed. Their durable queue and normal retry/scheduling policy remain intact. Documentation reconciliation only; no additional application changes.


## October 19: explain source activation prerequisites

Investigated the Owner's missing activation actions. Hosted data confirms four approved website collectors and 31 proposed/manual entries with adapter_required=true and no extraction profile: 15 public listings, nine supplier-registration portals, four central redirects and three procurement platforms. Frontend canCollectSource hides Enable for these rows; SQL independently rejects source.action approve with ADAPTER_REQUIRED. The five-enabled-source trial cap remains in frontend and SQL, but is not causing the current four-enabled/31-unconfigured state. No role, source, permission, scheduler or database configuration was changed.

UI now shows Setup required, a reason based on stored catalog metadata, and an actionable Set up collection link (View requirements for non-Owners). Details explain the missing integration and the save-paused-then-enable sequence. Manual sources without an extraction profile must explicitly select a collection method instead of silently defaulting to RSS. Supplier registration is explicitly distinguished from an available tender listing. This fixes the misleading blank Actions column; it does not claim to implement the 31 missing integrations.

Expanded the existing HTTP/SQL/worker integration flow to start with a manual source: premature enable is denied, valid feed configuration persists paused, enabling succeeds at the new revision, the worker collects, and repeated collection deduplicates. All **266 backend tests / 25 files**, TypeScript and build passed. Frontend **175 tests / 32 files**, TypeScript and build passed. Local Chromium passed five checks at 1440px and 390px: actionable list-to-setup navigation, explicit method validation, responsive setup layouts and configure/reload/enable/persist. This used an isolated synthetic fixture with no external requests and was removed before the production build. Hosted authenticated browser acceptance is not claimed. Publication pending. Runtime and database schema are unchanged from v42.


Published source `f8313c9d3cd27b2b209a56852b693692853bcb06` passed [Pages 39244372467](https://github.com/salahassi/tenders/actions/runs/39244372467), including all **441 tests**, TypeScript, Deno and build. Published index, Sources, SourceDetail and admin CSS assets match local output byte-for-byte. Hosted function readback confirms both the adapter guard and five-enabled-source limit remain in collection_command. The missing-setup UI and explicit method choice are deployed; the 31 unconnected sources still require real integrations, and no hosted source was activated by this release. No hosted authenticated browser session is claimed. Documentation-only reconciliation follows this release.


## October 19: remove the five-enabled-source limit

The Owner explicitly authorized removal. Both frontend activation paths now submit normal source.action commands without counting enabled sources. Migration 20261019113019_remove_enabled_source_limit replaces only the enabled-count guards in app_private.collection_command and app_private.evidence_command, retaining authorization, adapter/access requirements, revisions, auditing and idempotency. It does not modify source rows, scheduling policy, permissions or unrelated capacity controls.

Local verification passed **267 backend tests / 25 files** and **177 frontend tests / 32 files**, both TypeScript checks and production builds. A PostgreSQL integration test enables seven sources, pauses/resumes one while six remain enabled, confirms all seven schedule, and confirms stale revisions, unconnected sources and missing access configuration are still rejected. Connected UI tests cover the sixth source from both list and detail views. Local Chromium independently passed directory resume, detail pause/resume and persistence across reload with six active synthetic sources, zero external requests and no page errors; the isolated fixture was removed before building. No synthetic source was created on the hosted workspace.

Hosted migration **20261019114305** applied successfully. Readback confirms both count guards removed and security-definer settings, empty search_path and postgres-only ACLs unchanged. Restoring the removed guard in a read-only hash expression exactly reproduces both pre-migration body hashes, proving no other hosted function change. Local evidence_command matches the hosted body; collection_command differs only by a pre-existing unused operation_key declaration in local migration history. Security advisor categories/counts remain unchanged (3 private no-policy tables, 22 authenticated security-definer RPC findings, leaked-password protection). The 35 real sources retain their activation revisions and states (four approved); frontend publication and release reconciliation pending. API/worker code remains v42; no Edge Function redeployment is needed for this SQL/UI change.


Release `19a91b6f22e8296120b0f5974f0dedda2e9b6759` passed [Pages 39246966583](https://github.com/salahassi/tenders/actions/runs/39246966583), including all **444 tests**, TypeScript, Deno, build and publication. Published index, Sources and SourceDetail bundles match the tested local build byte-for-byte. Hosted source activation hash remains `9cccb78cb53eaf8a2c08f7b437fb4d50` before/after migration (35 records, four approved), confirming no source activation/revision changes. Database migration and frontend rollout are complete; additional prepared sources can be enabled or resumed without the retired five-source ceiling. Documentation-only reconciliation; runtime v42 and existing connections remain in place.

## October 19: collect notices and discover source links together

Collection stage: combined mode implemented with a database-owned adapter_config.discover_source_links flag alongside the existing validated extraction profile. One page fetch returns both notices and source candidates through the existing transactional completion function. Configured listing rows, including filtered/superseded notices, cannot become candidate sources. Combined discovery also excludes navigation, attachments, self-links and duplicates. Candidates remain manual/proposed with adapter_required=true, no approved hosts and no schedule; discovery does not fetch or enable them. A broken notice schema fails the collection rather than recording partial success. No migration or source-row change is required.

Local backend verification: **269 tests / 25 files** passed, including an HTTP/API/SQL/worker flow that saves combined settings, collects both result types, repeats collection without duplicates, and rejects premature candidate activation. The parser fixture confirms one fetch and exclusions, while notice-only operation still produces no candidates. Both package TypeScript checks/builds and Deno API/worker checks passed. Frontend **178 tests / 32 files** passed, for **447 tests** overall. Local Chromium passed combined save/reload, switching back to each separate mode, and 1440px/390px layouts with no page errors or external requests. Its isolated synthetic fixture was removed before building. API and worker **v43 ACTIVE**; readback matches all **33 reachable files** exactly. No authenticated hosted browser or actual combined-source collection acceptance is claimed.

Release `c1d4c13d230adb1e41dd58820e03b2dc5ed630e1` passed [Pages 39249486209](https://github.com/salahassi/tenders/actions/runs/39249486209), including all **447 tests**, TypeScript, Deno, build and publication. Published index HTML, main JavaScript, Sources and SourceDetail bundles match the tested local build byte-for-byte. Hosted API health returns 200; anonymous sources and worker access return 401. Runtime and frontend publication are complete. Existing source modes were not changed; Owners can select the combined mode for a configured source, save it paused and enable it through the usual controls. This final reconciliation changes documentation only.


## October 19: automatic public source reading and separate source discovery

Collection/discovery stage: implementation complete; verification and deployment pending. The Owner requires automatic adaptation to public websites and explicitly separates finding new source URLs from configuring an existing tender source. Enabling an HTTPS catalog source now selects generic model-assisted reading when no extraction profile exists. Existing saved feeds/profiles remain supported. Source configuration defaults to automatic reading with URL/schedule and optional advanced settings; it no longer offers source discovery or combined discovery. The Sources page has a separate Owner-only Discover sources action; suggestions remain proposed until reviewed/enabled.

The worker freezes a fetched public page, validates an exact-hash processing manifest against the current approved provider policy, and uses the existing routing/failover/usage ledger. Model-selected links must exist in the fetched page; extracted titles/fields/quotes must match its text. Observed navigation may cross public hosts, with HTTPS and public-DNS checks on every request/redirect and no cookies/credentials. Page continuations use the existing leased queue and do not refetch frozen evidence during model retries. Newly collected notices receive detail reading before assessment; credential-driven routing can schedule assessments without a manual model-settings row.

This release reads HTML and text PDFs. It does not execute website JavaScript or OCR images/scanned PDFs, submit forms, log in, or purchase documents. Such pages report actual access/format blockers. Each reading is bounded to five pages, 100 results, 60,000 text characters and 200 links per page; coverage limits are recorded. No runtime institution-specific registry is introduced. No catalog entries are bulk-enabled and no candidate source is automatically enabled. Completed page snapshots are removed; measured model usage remains linked to the job. Backend-only RPCs and workspace RLS protect frozen public-page evidence.

Local regression, browser checks, hosted migration, runtime deployment and actual-source acceptance will be recorded separately below.

Local verification passed **273 backend tests / 26 files**, followed by the expanded five-test automatic-source integration suite (274 total current backend tests). Frontend **179 tests / 32 files** passed, with a subsequent 23-test connected-screen regression after adding readable source-job messages. Both TypeScript/build checks and Deno API/worker checks passed. Local Chromium passed five desktop/mobile activation, save/reload, independent discovery and suggestion-review checks without external requests or browser errors. The synthetic fixture was removed before production builds; no authenticated hosted browser acceptance is claimed.

The initial combined migration request returned Invalid or expired requestState; readback proved no objects/history were created. Split migrations preserve the same logic, with worker-only grants also applied in the first transaction. The completion request required one retry after the same tool error and an absence check. All three migrations are now applied; the five-test integration suite passed against their exact file order. API/worker **v44 ACTIVE**. Runtime readback, Pages publication and real-source verification are pending.

Release `a9683d73bee962e899ff2a78671f3f8018f3db67` passed [Pages 39261564447](https://github.com/salahassi/tenders/actions/runs/39261564447). Published index and Sources/SourceDetail bundles match the local build. API/worker v44 readback matches all **36 reachable files** exactly; health returns 200 and anonymous sources/worker requests return 401. Hosted migration versions are `20261019133023`, `20261019133431`, `20261019133453`. Security advisory categories/counts are unchanged (3 private no-policy tables, 22 authenticated security-definer findings, leaked-password protection). No new unindexed foreign key; the new workspace index is initially reported unused.

The audited Owner action enabled the actual Saudi Ministry of Health source with automatic reading, preserving its URL and catalog identity. Its first collection job initially waited behind older assessment retries. A follow-up queue migration gives source work waiting two minutes a turn while preserving accepted remote-request priority, eligibility times and per-workspace lease serialization. Attempts/continuations reset that priority so sources also yield. The six-test integration suite proves both directions; complete regression and hosted source results pending. No synthetic hosted source/opportunity or model result was created.

Queue follow-up `3d5863ae35f2448bbf18b3ae1d06a12ef3c7e93a` passed [Pages 39262169930](https://github.com/salahassi/tenders/actions/runs/39262169930); local full regression passed **275 backend tests / 26 files**. The real Ministry source then fetched **5,475 characters and 111 observed links** but correctly recorded a pre-send DATA_POLICY_BLOCKED result. Investigation isolated the public site's repeated privacy-policy navigation label containing the word “confidentiality”; no model generation was sent for that attempt.

A targeted extraction correction removes only an anchor explicitly labelled as the site's privacy policy and linking to a privacy URL. Actual confidentiality markings and privacy-related tender documents remain unchanged and blocked where appropriate. The real fetched page then retains **5,414 characters, 109 links and all five observed Etimad links** without a false policy block. Worker **v45 ACTIVE**; API remains v44. The old job was audit-canceled and a fresh collection queued, preserving the old evidence/history. Automatic-source/privacy tests pass, including restricted-text preservation; final regression and actual model result pending.

After the privacy-navigation correction, all **276 backend tests / 26 files** passed, both backend TypeScript/build and Deno checks passed; frontend remains at 179 passing tests with unchanged published assets. Worker v45 readback matches all 19 reachable files. A final recovery integration test identified and fixed independent discovery retries trying to load an unrelated source revision: workspace-owned directory jobs now preserve their original directory hash. The expanded **eight-test** automatic-source suite passes, for 277 current backend tests. Full hosted workflow validation and final source observation follow.

Final release `d4061ae3f499b5cd3c8050cc440456997b962b51` passed [Pages 39263110594](https://github.com/salahassi/tenders/actions/runs/39263110594), including **277 backend and 179 frontend tests (456 total)**, TypeScript, Deno and production build/publication. Published index, main JavaScript/runtime, stylesheet and both source-page bundles match the tested local build byte-for-byte. Runtime remains API v44/worker v45 with exact readback; all four source-reading RPCs are service-role-only and the new table has workspace RLS. Final security advisor categories/counts are unchanged; the pre-existing [RLS no-policy advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) concerns the existing private tables, not source_readings. Queue/retry migration versions are `20261019133956` and `20261019134702`.

Hosted acceptance at approximately **2026-10-19 13:50 UTC**: the actual Ministry page was fetched and its minimized frozen text accepted for a Gemini background request (HTTP 200). The subsequent attempt received Gemini **429**, then failed over to Groq (**413 request too large**) and z.ai (**MODEL_NETWORK_UNCERTAIN**). The source job is **retry_wait / MODEL_ROUND_EXHAUSTED**, retaining its evidence and automatic retry schedule; token usage is unreported, not zero. This proves live collection activation, public-page fetching, authorization, provider submission, failover and recovery. It does **not** prove completed model extraction, following the Etimad link, new opportunities or an end-to-end successful assessment for this source. No completed source result is fabricated. External inference availability/request limits and JavaScript/OCR capability remain explicit acceptance limits. Five sources are now enabled (the four existing collectors plus this Owner-requested Ministry source); the remaining catalog sources were not bulk-activated.

Code, migration, runtime and frontend publication are complete. Local Chromium fixture acceptance is recorded above; authenticated hosted browser acceptance is not claimed. The production source continues retrying unattended. This final reconciliation is documentation only.

## October 19 — grouped failure mail and source retry diagnosis

Owner reports excessive failure mail and no visible discoveries after enabling sources; also requests Discover sources next to Add source. Diagnosis: failure mail was deduplicated per job, so the same model outage emitted one email for each affected assessment. Actual source attempts showed provider 429s, Groq 413/request-size rejection and invalid model output, plus an independent MDLF HTTP 503. Greater Amman subsequently completed automatic collection of 20 actual notices; initial assessment state was 13 queued / 7 NOTICE_DETAILS_NEED_OCR, not a failed activation.

Implementation: recipient-owned failure alert interval (1/6/12/24h; default 1h), durable grouped notification membership, current-job checks before dispatch, preserved per-job in-app history, no replay of already-sent/ambiguous historical deliveries. SMTP acceptance/unknown handling is unchanged. Source model prompts remove duplicated evidence envelopes and task-irrelevant instructions, normalize invisible formatting without permitting invented citations, and include a repair instruction on subsequent attempts. Model validation diagnostics record fixed failure categories without raw text. Provider Retry-After is honored per provider/model/project; a last provider's long delay no longer stalls the whole pool. Previously deferred exhausted rounds are rescheduled within an hour with audit evidence. Source suggestions remain separate; the Discover sources action moves into the Sources header beside Add source.

Status: code implemented; focused tests and full package verification/deployment/hosted readback pending. External HTTP failures, provider availability, and image-only OCR remain distinct from code acceptance. No invented production opportunities or test emails.

Verification/deployment update: backend full suite **282 tests/26 files** passed, frontend **179 tests/32 files** passed, both package typechecks/builds and both Deno entrypoints passed. A subsequent populated-upgrade regression passed with the notification suite (**17 tests**) after correcting the migration audit actor; provider/notification integration checks also passed (**55 tests** before that additional case). Chromium local synthetic acceptance passed at 1440px and 390px: adjacent header actions, independent dialogs, suggestions, and persisted failure interval, with no console errors or external requests. Temporary browser fixture removed from the repository.

Both hosted migrations are applied. Runtime **worker v46 / API v45** is active with canonical shared files. Live preferences retain email enabled and default to a 1-hour failure-summary interval; provider-specific wait repair retained cancellation guards and audit history. Final GitHub publication and hosted after-deployment observations remain to reconcile. Source acquisition is not universally successful: MDLF still returned HTTP 503 independently, MOH/PIF model retries remain outstanding, and seven initial Amman attempts reported OCR (superseded by the redirect diagnosis below). The 20 Amman notices are real database records; no model-based assessment completion is asserted by this entry.

Follow-up diagnosis corrects the initial OCR interpretation: all 20 Amman detail attempts eventually returned NOTICE_DETAILS_NEED_OCR. Independent public inspection of an actual notice URL showed an HTTP redirect to the site's default homepage, including when a normal public cookie jar and listing referrer were used. The generic HTML reader had selected the homepage's first short article and incorrectly labeled it OCR. The follow-up distinguishes redirected/unresolved HTML, image-only pages, browser-rendered pages and empty content; it does not treat homepage text as tender evidence. A new regression covers these distinctions. Existing evidence is preserved and the remaining inability to obtain notice details is explicit.

Redirect follow-up acceptance: final local backend **284 tests/26 files**, frontend **179 tests/32 files**, both typechecks/builds, and both Deno entrypoints pass. Hosted **worker v47 / API v46** now distinguish the HTML blockers. The 20 existing Amman detail jobs were requeued with audit entries, preserving evidence and attempt/failure counts. Main code `2ea592a` passed [GitHub publication 39270466005](https://github.com/salahassi/tenders/actions/runs/39270466005); live assets already contain the adjacent source actions and saved failure-frequency control. Hosted migration versions are `20261019143211` and `20261019143417`. The mailbox held at 42 historical failure deliveries with none newly queued after runtime deployment through the latest readback. MOH's compact source prompt was accepted as a real Gemini background request (200), then the round again exhausted; completion is not asserted. PIF remains in automatic recovery, and MDLF's independently observed HTTP 503 remains external. Final follow-up publication/readback is pending.


Final acceptance: source revision **cf0ce3397fa5d912abb39911ab9a663fbff595f6** passed [GitHub build and Pages publication 39271922928](https://github.com/salahassi/tenders/actions/runs/39271922928), including all 463 tests, TypeScript and Deno checks. Live worker readback confirmed SOURCE_NOTICE_REDIRECTED for the first two Amman rechecks, with 18 still queued at that observation, and zero additional failure deliveries since the runtime release. The corresponding real public HTML also produced SOURCE_NOTICE_REDIRECTED in the corrected local parser. Code, migrations, worker/API deployment, Pages deployment and local browser acceptance are complete. Authenticated hosted browser acceptance and successful model assessment of the new Amman notices are not claimed. Remaining external acceptance: inaccessible/redirected detail URLs, provider quota/availability, and the MDLF 503. The collector continues on schedule; no alert preference or provider was disabled to suppress symptoms. This final reconciliation is documentation only.

## October 21 — wake successful unchanged notice continuations

Read-only hosted timing found three successful `notice.details_unchanged` completions at 12:57:37.974, 13:04:11.970 and 13:05:21.880 UTC. Each preserved its assessment job as due `retry_wait` with no error, but the existing wake admission did not recognize that healthy local continuation. None had a wake receipt; the next model operations started 32.6, 54.2 and 42.6 seconds later, respectively. This identifies approximately 129 seconds of observed delay across those three handoffs; it is not a projection of total remaining proposal duration.

Migration `20261021130940_wake_unchanged_notice_continuations.sql` adds the exact released lease and resulting job revision to the existing immutable notice audit record. Only a due, error-free classification continuation with that current receipt can enter the normal queue wake policy. Existing workspace serialization, active lease/reservation/restore guards, cancellation, revision deduplication, ten-second throttle, normal claim ordering and cron fallback are unchanged. There is no extra timer, new generation request, model routing change, checkpoint edit or budget reset. Historical audit records lacking the receipt fields do not qualify.

Local verification: **155 tests / five files passed in 23.14 seconds**, including 15 new canonical completion/wake/claim tests and the existing queue, deferred-wake, notice-details and release-command suites. Tests cover unchanged frozen inputs/checkpoints and zero provider calls, one normal lease, ordinary interactive priority, replay/wrong-lease/new-revision rejection, future eligibility, failures/backoff, cancellation, active leases, reservations, restore, disabled dispatch, throttle and service-only RPC access. Independent SQL review found no blocker. No hosted application or deployment of this migration is claimed by this entry.

Hosted update: the migration was applied successfully at 13:17:36 UTC
(hosted migration version `20261021131736`).
Worker/API bundles are unchanged. The next qualifying live continuation receipt
and wake remain to be observed. Source `b7301a9c86286bfb95fd3b5fa5d98359d20b3b6f`
passed [CI and Pages 39605737413](https://github.com/salahassi/tenders/actions/runs/39605737413).

Live follow-up: a qualifying unchanged-details receipt at **13:47:20.772 UTC**
was matched by a wake for the exact released job revision at **13:47:20.948 UTC**
(0.175 seconds). No new model usage or polling attempt occurred for that job
after the receipt through the 13:49 snapshot. This proves dispatch, not faster
completion: the continuation was still waiting while proposal work progressed.


### 2026-10-29 — scope keyword evidence guard correction

The approved real assessment reached OpenAI successfully (three settled writer responses) but the local evidence guard rejected every numeric scope factor for missing company citations, despite the frozen `combined` policy allowing selected keyword evidence. Read-only metadata confirms no verified company blocks, a numeric scope rating with notice citations and nine selected keyword references; the other three factors remain unknown. Repair candidates are retained immutably and are not evidence of a completed assessment.

Implementation now permits only the scope factor to use a valid frozen `keywords`/`combined` policy with definite, validated selected keyword evidence and valid notice citations. Company capability, prerequisites and sector still require both evidence types for numeric ratings. Trusted context is supplied during initial, repair, generation and exact retained-writer validation. Prompt/schema pins, existing content, writer budgets, usage and attempt counters are unchanged. Recovery must validate the exact latest paid candidate and then pass ordinary independent verification before releasing the remaining assessments or Needs attention jobs.

Local evidence: backend typecheck/build and all **1,492 tests / 87 files** passed, including 19 new regressions; focused related suites passed 95 tests. Deployment and live sample acceptance remain pending at this checkpoint.

Boundary review additionally found and corrected policy propagation at final graph acceptance and invalid-verifier recovery. An end-to-end regression reproduces three old-guard writer rejections, then revalidates the exact latest retained candidate, obtains independent verification and reaches graph acceptance while writer calls remain three and prior receipts/budgets remain identical. The corrected boundary suites passed **83 targeted tests** and backend typecheck; the final source revision must complete fresh deployment verification before live recovery.

The incident-specific paid-sample recovery action additionally verifies the exact immutable ready API/worker image and known latest candidate-2, frozen version-3 semantics, selected keyword policy, notice references and three distinct settled counted writer receipts. One canonical retry is audited, and transaction snapshots assert that graph state, checkpoints, writes, budgets, usage, attempts and job attempt counters are unchanged by retry. Four recovery tests pass, including real graph-table DDL validation, rejection cases, rollback on budget mutation and idempotent replay; the complete local operations suite passed 135 tests before the last additional rejection assertions. Corrected source `6af8b4829456e6789501d83351c7a0e748b32565` is undergoing deployment workflow `40871050171`; live recovery is still gated on its success.

The read-only batch observer uses unique owned credentials/pod resources, strict database TLS and aggregate-only logs. It follows latest nonarchived assessments and exact matching persisted fit identities, reports business review separately from operational attention, and treats quota waits as pending. Seven observer tests pass, including PostgreSQL scoping, stale-fit exclusion and mixed terminal outcomes. With these additions, the complete local operations suite passes **142 tests**.

Final corrected guard deployment succeeded: source `6af8b4829456e6789501d83351c7a0e748b32565`, workflow `40871050171`, immutable runtime `sha256:74db4c5aa8a534de1a7e85dcd590a9605b89357bbd6aa859d61f63d828139b06`. Both package typecheck/test/build (**1,495 backend and 241 frontend tests**), 132 operations tests and 13 renderer tests passed remotely; all five workloads and public auth/configuration boundaries verified. The live sample has not yet resumed at this checkpoint.

The first live paid-sample recovery attempt rolled back at its preflight without releasing the sample or other 17 jobs. The recovery guard assumed a cumulative thread candidate count; authoritative budget-version-2 code instead records the original writer and corrections separately. The guard now requires the unchanged version-2 split (thread/original count 1, writer budget 1, correction budget 2), plus all three distinct settled retained receipts. Fixtures use the actual migration and split counters. Recovery stdout now whitelists anonymous operational state/counts only; Shared SQL diagnostics retain their existing generic redaction. The incident branch passed **143 remote operations tests** and the final 5 recovery tests. The full local operations suite, including optional diagnostic/assist helpers, passed **154 tests**. Live acceptance is recorded below.

Public diagnostic expansion is excluded from the recovery release. This release corrects only the proven split-counter contract and limits public recovery output to anonymous operational progress; shared SQL diagnostics retain the existing generic error behavior.


### 2026-10-29 — approved assessment recovery accepted

Read-only observer workflow `40874669501`, attempt 3, job `123483076711`, verified **18 latest completed assessments and 18 matching persisted fit records**, with **zero pending jobs, zero pending opportunity refreshes and zero blocked/failed attention jobs or plans**. Recovery workflow `40873973970` completed the exact retained paid sample before canonically restarting the other 17 requested assessments. No counters, retained receipts or model budgets were reset.

The deployed runtime source is `6af8b4829456e6789501d83351c7a0e748b32565` (immutable runtime `sha256:74db4c5aa8a534de1a7e85dcd590a9605b89357bbd6aa859d61f63d828139b06`), verified by deployment workflow `40871050171`. Both application packages passed typecheck/test/build (**1,495 backend and 241 frontend tests**), plus 143 incident operations tests and 13 deployment-renderer tests. This closes the approved assessment-recovery incident; business fit review remains separate from operational execution.

## November 3 — distinguish ambiguous usage from writer identity failure

Stage M4 model execution: the production proposal retained a schema-valid repair
candidate with local citation findings after earlier providers returned uncertain
network/accounting outcomes for the same operation. The writer-validation handoff
returned `false` for that accounting guard; the graph translated every such
refusal to `MODEL_IDENTITY_CHANGED`. The candidate's recorded request and provider
identity were consistent, so the displayed blocker hid the actual requirement.

Migration `20261102231710_writer_handoff_usage_blocker.sql` preserves the existing
same-operation usage guard and raises `USAGE_REVIEW_REQUIRED` explicitly. Genuine
identity failures, active reservations, lease checks, content authorization and
private function permissions remain enforced. The migration changes no business
rows, receipts, accepted requests or candidate budgets and can be replayed safely.
It does not settle unknown usage or release blocked paid processing automatically.

Local verification: all **93 tests in five graph/recovery suites passed**, including
**46 writer-handoff integration tests**. New PostgreSQL cases distinguish unknown
usage sharing the input hash or request prefix from unrelated earlier-phase usage,
and verify immutable receipts, retained candidates, budgets and accepted-result
state. Existing replay, stale-lease, cancellation, revoked-permission and private
function-access tests pass. Runtime deployment and fresh production acceptance
remain pending the coordinated AI reliability release.

## November 3 — terminal provider request lifecycle and failover

The live assessment diagnostics showed repeated OpenAI GETs returning HTTP 200
with terminal `failed` responses and no reported usage. Settlement correctly kept
usage unknown, but the resume functions excluded failed responses only when usage
was settled. This conflated request lifecycle with billing certainty and kept
polling terminal requests across worker leases.

The runtime now records `PROVIDER_BACKGROUND_TERMINATED` only for explicit
`failed`, `cancelled`, or `canceled` provider status under the accepted remote
identity. Migration `20261102231721_terminal_background_request_lifecycle.sql`
excludes that marker from legacy/catalog/phase resume and orphan retrieval.
Remote IDs, deadlines, reservations and unknown token counts remain intact;
no historical generic rejection is reclassified. Same-provider duplicate-request
protection remains in force. Other providers can complete the existing fallback
round. Abandoned-request reconciliation also records explicit termination even
when usage is absent. HTTP 200 error envelopes retain bounded error code/type
metadata and are classified as provider failures rather than truncated content.
Provider messages and response content are not added to diagnostic logs.

Local verification passed 132 tests across catalog, continuous worker and
round-robin suites, plus 111 model/contract/stream/QwenCloud tests. Coverage includes
all three terminal statuses, legacy and catalog OpenAI-to-QwenCloud continuation,
remote-ID mismatch, unknown accounting preservation, generic ambiguous errors
remaining resumable, no duplicate POST, and stopped orphan polling. Backend
full-suite checks, live provider evaluation and hosted release evidence are
tracked by the current overall AI reliability entry; these local fixtures do
not establish provider account availability or hosted acceptance.

## November 3 — guarded API/worker release for AI execution reliability

Stage: M4 model execution and M6 operations. The dedicated
`deploy-ai-reliability.yml` workflow runs the complete package and operations
checks on its review branch. Production access, image publication and release
are restricted to manual dispatch. The release updates only the API and worker
immutable images, waits for their old processes to drain, and applies exactly
`20261102231710_writer_handoff_usage_blocker.sql` and
`20261102231721_terminal_background_request_lifecycle.sql` in one transaction.
A checksum ledger makes the release replayable and rejects changed migration
content. Existing public rows and saved graph/accounting records are compared
inside PostgreSQL; function ownership, grants, security-definer flags and
search-path settings must remain unchanged. Browser execution grants remain
denied. No processing retry or inference is performed by the updater.

Image patches test workload UID, resource version and prior image. Other
workload specs, frontend configuration, core/runtime secrets and native
schedules must remain unchanged. Failure before the schema attempt restores
only this release's image changes; an ambiguous schema acknowledgement retains
the runtime compatible with either schema. Temporary administrative and runner
credentials are cleaned. Existing administrative resources are not adopted.

Local validation: all nine focused release guards passed, including the actual
migrations against the full schema as a restricted application owner, repeated
application, rejection/rollback of altered business rows and grants, checksum
drift, concurrent workload replacement/image changes and failure-path cleanup.
Python compilation and diff whitespace checks passed. These are local fixture
and guard results. Publication, production deployment and live model acceptance
remain pending and must be recorded with their exact source/run evidence by the
release owner.

## November 3 — bounded live AI contract evaluation

The Owner explicitly requested live AI model and prompt testing. A dedicated
manual GitHub workflow evaluates up to four enabled OpenAI/QwenCloud catalog
models against eight isolated synthetic cases each, with a hard ceiling of
32 generation requests and 4,096 output tokens per request. Push events run
only offline guards. Live execution requires the explicit manual `run_live`
input; it reads the current catalog and runtime key aliases without persisting
synthetic application records or changing routing, permissions, jobs or usage.

The evaluator calls the actual `executeModel`, prompt constructors, adapter
transports and canonical result validators. Cases cover connection/background
completion, English evidence to Arabic output, Arabic evidence to English
output, untrusted instructions, unknown company fit, draft structure and
declared company claims, incorrect source-quote repair, and an unsupported
company claim in grounding. New analysis/repair tests use semantic policy 4;
classification uses 3 and other phases use 2, with verifier policy 2.
Draft-case acceptance covers canonical structure and declared claims; it is
not a semantic audit of arbitrary generated prose or a full proposal-to-Word
acceptance. These deliberately small synthetic cases are a diagnostic suite,
not a held-out estimate of production accuracy.

Each case records exact prompt hash, contract result, bounded error metadata,
measured usage (unknown remains explicit), elapsed time and background cleanup.
Terminal failed/cancelled background responses are not repeatedly polled. A
process interruption retains completed case receipts with explicit incomplete
status and lower-bound request counts. Private encrypted output also contains
a read-only projection of current routes, frozen active assessment pools and
provider usage history, to resolve routing causes without exporting prompts,
documents or credentials. Key values pass only through child stdin in memory.

Verification: six Python operational guards and seven Vitest evaluator tests
pass; the Node 24 native TypeScript-transform import succeeds. The happy-path
fixture traverses all eight real prompt/validator paths with mocked transport;
separate tests cover actual 401 normalization, zero accidental activation,
request bounds, wrong quantities/obligation strength, credential isolation and
failed/cancelled background termination. No live request or hosted acceptance
is claimed by this implementation entry. Runtime deployment and saved-work
recovery are separate actions; the bootstrap deployment is not invoked.

The first activated run `41545119569` stopped during read-only routing diagnosis
before the provider subprocess started. Its SQL used the reserved PostgreSQL
keyword `current_catalog` as an unquoted CTE identifier; this was reproduced
against the complete local migration schema. The CTE is now named
`catalog_metadata`, preserving the private report field name. Both catalog and
routing SQL execute successfully as read-only transactions in the full-schema
PGlite regression, and that regression now gates the live workflow. Failure
receipts retain a fixed orchestration stage and sanitized SQLSTATE/line, so a
future setup error can be identified without emitting SQL, provider content or
credentials. The interrupted run submitted zero model requests and supplies no
live model acceptance evidence.

The content-permission diagnostic now separately projects current discovery
policy flags, provider inclusion, approval timestamp/current membership, and
aggregate exact-hash grants for frozen assessment notice/verified company
references. It includes valid interactive request receipts and later explicit
revocation counts, matching the October 31 requested-processing distinction:
selected requested notice/style material can bypass repeated permission checks,
while verified company evidence retains its existing authorization requirements.
No content-check/preflight/autoauthorization function is invoked. The SQL uses
read-only repeatable-read isolation, exact database/workspace guards and bounded
execution; it returns no document text, content hashes, user or entity IDs,
credential aliases or secret values. Missing QwenCloud consent remains missing.

Local verification: all five exact catalog/routing/content diagnostic SQL tests
pass against the complete current migration schema, including wrong-target
rejection, populated explicit/policy/revoked reference counts, requested versus
automatic assessment distinctions, unchanged authorization rows, and sensitive
projection exclusions. A current policy snapshot does not establish its state
on October 31; historical cause requires separate timestamped evidence. Hosted
execution of this added diagnostic completed in the private live evaluation
reports; the reconciled current-policy finding appears in the integrated
verification entry above.

## November 3 — versioned planning ownership guidance

Stage: M4 planning and evidence validation. The bounded live blueprint case
failed twice on Qwen3.8 despite valid JSON and exact source quotations. The
private synthetic diagnostic candidate listed both buyer requirements in
processed IDs, cited decisions and missing-company questions, but contained
only an executive-summary unit with no primary requirement owners. The existing
production ownership validator correctly rejected it.

New, unstarted structure/blueprint phases and their repair/verification phases
pin semantic revision 5. Its separate planning policy distinguishes processed
IDs from primary narrative ownership, retains ownership when company proof is
missing, preserves assigned detail scope and frozen decisions, and supplies
sanitized path/ID-specific repair actions. A partial verification content batch
cannot establish global missing coverage. Existing revisions 0–4 and paid
phase pins remain immutable; no ownership or evidence guard is relaxed.

Local validation: 98 tests across planning policy, phase pins, analysis evidence
and durable writer handoff pass. Synthetic Arabic/English regressions reproduce
the rejected executive-only shape and validate a substantive narrative repair
that preserves factual decisions and unresolved questions; wire hash snapshots
cover all prior revisions, and real database tests cover new and existing pins.
Backend typecheck passed after the concurrent validator-test changes. Bounded
live revision-5 acceptance passed both fresh blueprint and captured-candidate
repair in run `41550112563`; deployment and old-work recovery remain pending.

## November 3 — durable repair of proposal planning coverage failures

The activated synthetic QwenCloud evaluation returned schema-valid blueprint
JSON with both processed requirement IDs but only an executive-summary unit;
neither requirement had a primary narrative owner. Production already invokes
blueprint, structure and planning-detail validators inside the writer phase,
before success/acceptance. Their bare domain errors, however, lacked the typed
diagnostics required by the durable writer handoff. Consequently the same
unchanged planning prompt could consume the initial provider-attempt budget
instead of entering the existing bounded correction phase.

Existing planning rejection rules now attach bounded diagnostic reasons,
structural paths and relevant reference IDs, including missing/duplicate
owners, invalid section scope, template/decision references and unknown
aliases. Validation and acceptance continue to use canonical requirement IDs;
only diagnostic metadata is mapped back to the model-visible aliases for
aliased planning. Structure diagnostics refer to its actual schema, excluding
virtual blueprint units used internally for validation. No model budget,
immutable result, existing prompt identity, usage receipt or authorization is
rewritten; no validation condition is removed.

Local verification: 85 tests across proposal blueprint, hierarchical planning,
generation callback and durable writer-handoff suites pass; backend typecheck
and diff whitespace checks pass. Two real-database graph regressions reproduce
summary-only blueprint/structure outputs, retain each rejected paid candidate,
enter one repair-result phase, perform independent grounding, and accept only
the corrected full ownership map. They assert one initial writer plus one
repair allowance, unchanged original settled usage/candidate evidence, and no
new request on accepted replay. Additional regressions cover bounded metadata,
actual schema paths, alias/canonical identity separation and unchanged rejection
of invalid ownership, source references and detail scope. The separate bounded
live acceptance passed in run `41550112563`, as recorded above. Production
deployment and recovery of existing blocked work have not occurred.

## November 3 — inspect the exact paid proposal before recovery

A separate manual inspection workflow now accepts an encrypted exact-workspace,
opportunity and proposal-plan selection. Its repeatable-read, read-only SQL
returns private operational metadata for that opportunity: current/latest plan,
proposal and opportunity revisions, original snapshot/source fingerprints,
current document hashes/counts, workflow-admission gates, graph phases/budgets,
accepted-request/unknown-usage indicators and available proposal-version IDs.
It exports no document text, prompt, response, title, filename or credential.
Public workflow logs contain only fixed inspection/cleanup status and the
encrypted report's plaintext verification digest. Push on the dedicated recovery
branch runs offline guards only; production inspection requires manual dispatch. Existing
private encrypted transfer and uniquely owned SQL-client cleanup are reused.

Five operational tests pass, including execution against the full migration
schema, wrong-target/database rejection, private-field exclusion, preservation
of original usage/graph/policy records and confirmation that no authorizing or
canonical mutation wrapper appears in inspection SQL. No production inspection
or recovery has run from this implementation. The existing authorization-only,
never-sent resume helper remains unchanged; a paid correction-exhausted plan
requires a separately reviewed canonical recovery action after current evidence
and deployed-runtime verification.

## November 3 — bounded observation of one resumed proposal

The separate `observe-proposal-generation.yml` workflow observes an exact private
workspace/opportunity/plan selection. Pushes on `codex/ai-reliability-resume`
run only offline guards; live reads require manual dispatch and the expected
immutable API/worker runtime digest. Each sample rechecks that runtime and runs
an exact-target, read-only aggregate query. The observer does not invoke the
worker, scheduler, model adapters, content authorization or application commands.

Observation is limited to 900 seconds with intervals of 15–60 seconds. The
nonce-owned client has a bounded setup/report margin and refuses cleanup of
foreign resources. Public progress contains fixed stages/statuses/error labels
and counts only; unknown error text maps to `UNCLASSIFIED`. A queued sample is
never interpreted as failure. Blocked/failed/canceled states require two stable
samples with no queued/running/waiting jobs or reserved requests. Completion
requires the selected plan's generated version to be the proposal's current
version. Timeout and attention remain distinct from completion. A final full
inspection and outcome are transferred encrypted; only its report digest enters
public logs. Cleanup failure produces a failed receipt.

Local verification: ten focused offline tests pass, including exact SQL against
all migrations, target mismatch guards, unchanged database rows, private-data
projection, bounded observation transitions, runtime mismatch before SQL,
owned cleanup, encrypted final reporting and cleanup failure. Python compilation
and whitespace checks pass. No live observation or completed proposal is claimed
by these implementation checks; exact workflow and generated-version evidence
remain to be recorded after the authorized resume.

## November 3 — authorized reliability release deployed and merged

The user explicitly authorized deployment, resume and testing. Runtime-only
workflow `41551634331` completed successfully on commit
`2684780552726f33e25f9ff9b29a2d3237a7a701`, publishing API and worker image
`sha256:2b3391d445071f196bebf4d635e23ec50d3b33a8795defbded511259ea8bde1e`.
The two reviewed function migrations passed verification with existing rows
and frozen work preserved; only the two runtime deployments were updated.
Public configuration/provider assets and other workloads were preserved.
Release ledger checksum:
`0353c429634df4f9ed3429074e8ff027ef7151b66edffdc467dae08ecb2f8f4b`.
PR #19 merged as `3bf07a7c4dd712093344e5f7b0819f0720f1353a`.

Read-only inspection `41552352731` verified both running images and the exact
selected original proposal: twelve blocked jobs, no active target leases or
reserved usage, and no completed proposal version or final accepted graph.
Its paid intermediate attempts, unknown usage and exhausted correction budgets
remain intact. Canonical successor recovery and actual browser draft Word
acceptance are pending; the preceding pre-release pending statements describe
their observation time, not the now-completed runtime deployment.

## November 3 — canonical successor for the inspected paid proposal

The Owner explicitly authorized deployment, resumed processing and real output
verification. The verified private inspection found the exact original proposal
still blocked in analysis: twelve queued steps, no completed step or final
accepted graph result, and 98 retained provider receipts (59 settled, 39 unknown).
Its accepted remote deadlines expired on November 1; no target reservation or
lease remains active. Historical unknown accounting remains unknown.

A separate recovery helper now delegates one canonical `generation.cancel` plus
`proposal.generate` transaction for that exact inspected target. It verifies the
reviewed ready API/worker digest, active canonical Owner authority, latest plan,
plan/opportunity/proposal revisions, exact document/job/usage fingerprints,
current evidence revision and unchanged workflow admission. The new plan must
preserve the original requested language and selected document IDs/content
hashes. The current admission remains unchanged (workflow 1); fresh analysis
phases naturally use the deployed evidence policy. No old prompt pin, received
candidate allowance, source classification, content grant or usage value changes.

Default check mode rolls back every canonical mutation. Explicit manual restart
runs only after offline checks and under the production mutex. The transaction
compares original plan/job inputs and full retained step, requirement, source,
usage, successful attempt and graph/result/checkpoint/budget fingerprints before
commit. A retained audit marker makes an ambiguous receipt safely replayable
without a second successor. Only private encrypted receipts contain target
identifiers; public output is fixed status/count plus report verification digest.

Local verification: five successor operational tests and five inspector tests
pass. The complete-schema integration uses the restricted production ownership
model and covers rollback check, exact-input refusal, recent unknown/active
remote/reserved guards, unrelated historical usage, final completed-work refusal,
original source/language preservation, admission preservation, atomic rollback
of a simulated accounting defect, retained successful attempts and idempotent
replay. Python compilation and diff whitespace checks pass. Production mutation
has not been invoked by this implementation; dispatch, resulting successor
progress and actual Word export remain separately recorded acceptance.

## November 3 — guarded actual draft Word export acceptance prepared

The separate `accept-actual-proposal-export.yml` workflow accepts an encrypted
selection of one completed plan and its exact current proposal version/revision.
Push on `codex/ai-reliability-resume` runs offline guards only; actual export
requires explicit manual activation and the expected immutable runtime image.
Read-only SQL verifies that target and one active allowlisted Owner. The helper
uses the existing genuine Auth `generate_link`/`verify` session pattern without
sending email, changing passwords, creating accounts or forging a browser token.
User lookup and application bootstrap verify that identity; local logout runs
after success or failure. Cluster/deployment credentials and their environment
paths are excluded from the Node/Chromium child.

Primary acceptance opens the deployed ProposalEditor and clicks its complete
draft Word download. Browser mutations are restricted to draft preparation,
generated-artifact reservation, matching private Storage uploads and completion:
at most two buyer-defined volumes and eight export writes. There are no model,
approval, review, invitation or submission commands. The explicit HTTP fallback
uses the actual frontend renderer; it never follows a started browser attempt.
Owner identity and exact current plan/version are rechecked immediately before
export and before success. Each browser file must match an independent
authenticated server download, its registered SHA-256, exact authorized DOCX
content and bundled font/structure checks. Concurrent role/version changes,
missing server bytes and mismatched files fail acceptance. Real approval
readiness is observed without filling missing business facts or approving them.

The encrypted private report retains verified Word bytes, exact export/artifact
identities, readiness blockers and any partial export identities. Public receipts
contain fixed path/status, counts and the report verification digest only. No
customer document or screenshot enters public workflow artifacts. Local checks
pass: **15 Node acceptance tests, five full-schema selection tests, eight Python
guards, backend typecheck and diff whitespace checks**. Node 24 CLI import and
headless Chromium launch smoke checks also pass with browser networking blocked.
Independent review closed Owner-role, concurrent-target, server-byte proof and
child-credential-boundary findings. Harness source was committed in `a7ad08a`.
Actual hosted draft export and document layout review remain pending the resumed
plan's completed current version; these preparation checks do not claim either.

## November 3 — bind successor recovery to its complete prospective inputs

Two authorized recovery attempts safely refused before any mutation because
unrelated workspace evidence advanced between inspection and dispatch. The
workspace counter covers other tenders as well as the selected proposal; the
second refusal occurred after roughly three minutes. The read-only inspector
now records only the SHA-256 of the complete current canonical draft snapshot.
Recovery recomputes that same snapshot under its existing workspace lock before
canceling the predecessor, then requires the canonical successor's frozen
snapshot to match it exactly. No snapshot field is excluded or normalized.
The inspected global revision remains audit information; the newly generated
plan must record the current live revision. All original source, language,
latest-target, admission, runtime, authority, usage and immutable-history guards
remain active. Review inputs also join the retained source-history fingerprint.

Focused local verification passes: **five successor tests, five read-only
inspector tests and ten observer tests**. Complete-schema regressions prove that
an unrelated tender's evidence increment permits the exact authorized successor,
while changed company knowledge, template, rate or tender evidence refuses
before cancellation. An actual active-version review fixture proves review-body
snapshot sensitivity and the initial-draft business-state refusal. A simulated
canonical-side frozen-snapshot change rolls back both cancellation and generation.
The successful case retains prior usage, attempts, candidates, checkpoints and
budgets and records the live global revision. Python compilation and diff
whitespace checks pass; independent source review found no blocker.

The preceding helper baseline `a7ad08a` passed **2,139 tests**: 1,637 backend,
265 frontend, 224 operational and 13 document-renderer checks, plus both
application typechecks and builds, with no source-fingerprint changes. This
refinement changes operational inspection/recovery helpers only. No production
mutation or live provider request was performed by these local tests; a fresh
private inspection and separately authorized dispatch remain required for
actual successor and draft/export acceptance.

## November 3 — proposal-list Word download uses the connected export

Stage: M5 export. The proposal-list Word action previously packaged the client
display projection with the legacy local renderer. That projection omits the
server's commercial/delivery/review snapshot and volume separation, and flattens
structured section tables. The action now invokes the same connected draft
export as ProposalEditor for the clicked saved version. Server authorization,
frozen snapshot, buyer-defined volumes, artifact registration and authenticated
download remain in the existing shared export flow. Missing backend/version
identity and export errors report failure without creating a local substitute;
busy state lasts until the connected export finishes. Editor behavior and all
model/provider/accounting paths remain unchanged.
The list button and its accessible name explicitly identify the download as a
draft, including for an approved proposal row.

Four isolated component regressions cover exact selected version/draft mode,
deferred success and duplicate-click prevention, genuine export rejection and
missing connection/version failures. All **269 frontend tests in 40 files**,
frontend typecheck/build, focused formatting and diff whitespace checks pass.
Deployment and real list-button export acceptance remain pending; the separate
actual-editor acceptance does not establish list-button hosted acceptance.

## November 3 — canonical proposal successor started on DigitalOcean

Authorized restart workflow `41555786933` passed on helper commit `d4cbab1`.
It created exactly one successor through canonical cancellation/generation,
retaining all predecessor usage, paid attempts, graph history and correction
budgets. The complete prospective snapshot and original selected document
references were unchanged; the new plan preserves English and workflow v1
admission with twelve frozen blocks. Workspace evidence advanced from the
inspected revision 1816 to 1818 for unrelated inputs while the exact selected
snapshot remained identical. Both workloads matched the deployed immutable
reliability runtime. The encrypted receipt was downloaded and hash verified,
then its temporary transport object was removed.

Read-only observer `41556129126` is following only this successor, with a
900-second bound and no additional worker/model invocation. Creation of the
new plan is confirmed; generation completion, model acceptance and real draft
Word export remain unverified at this observation time.

## November 3 — connected list Word fix deployed; real generation progressing

Frontend-only deployment `41556412897` passed for commit
`5e64ab2c6404fcfa9a9d0b62cf8966bfcebf7797`, publishing frontend image
`sha256:b90ee4cea47e8208dd785aba618caaf89aadf3c8fd15e4c8172633b2883b88af`.
The same run passed 1,637 backend tests, 269 frontend tests, 224 operations
tests and both typechecks/builds; isolated workspace browser acceptance and
hosted PDF extraction passed. All 51 hosted assets matched. The release
changed only the frontend deployment and preserved all other workload specs
and public configuration; it accessed neither database contents nor secrets.
The API/worker reliability image remains protected by the active observer's
exact-runtime guard. Temporary release credentials and logs were removed.

The exact successor inspection `41556424196` observed real analysis activity
at 00:57:32 UTC: two QwenCloud measured receipts (Qwen and DeepSeek models)
with 16,262 input and 2,274 output tokens, two running graph threads and new
revision-4 analysis pins. The same snapshot showed no completed analysis
job or proposal version. One OpenAI accepted background request terminated
without usage and remained unknown; a later different OpenAI model request
was accepted and awaited polling. The report does not establish that terminal
request's provider-side cause. These are real transport/progress observations,
not completed semantic acceptance or Word export evidence. Private report
transfer was verified and its temporary object deleted. Generation and actual
editor draft Word acceptance remain pending ongoing observation.

## November 3 — private exact-job verifier failure diagnostic prepared

The actual successor reached a blocked analysis job after one writer response,
two verifier responses and one verifier-report correction. Its writer candidate,
provider receipts and exhausted verifier allowance remain retained. A separate
read-only diagnostic now binds one exact workspace, opportunity, plan and job
plus the deployed API/worker runtime digest. It reads the frozen inputs, selected
step, every immutable graph result (including each distinct invalid fallback
report), verification/prompt pins, serialized checkpoints/writes, bounded attempt
diagnostics and usage metadata. It invokes no model, authorization, refresh,
retry or accounting operation and does not alter the running observer.

Only encrypted private transport receives source text or candidate/report
content. Explicit metadata projections exclude credentials, routing snapshots,
HTTP headers, lease tokens and remote response IDs. Read-only database isolation,
statement/lock timeouts, row-count limits and 32 MiB report bounds fail closed
without truncating diagnostic artifacts. API/worker identity is checked before
client creation, before SQL and after SQL. Temporary resources retain nonce-bound
ownership checks and cleanup; public output contains only fixed status/error
labels and the report verification digest. Push runs offline checks; actual reads
require manual dispatch and no production mutation mutex.

Local verification: **seven diagnostic tests pass**, including a complete-schema
fixture under the restricted production database owner. It proves exact-job
scope, full writer/invalid-verifier payload retention, exclusion of sibling work
and injected fake credential metadata, unchanged usage/graph/source/audit rows,
wrong-target refusal, hard-size refusal and PostgreSQL read-only write rejection.
Python tests exercise all three runtime-change windows, private-error suppression,
invalid upload digests, private report publication and cleanup failure. Python
compilation and whitespace checks pass; independent source/test review is green.
No live diagnostic call or recovery mutation was performed by these tests. The
actual invalid verifier artifacts and cause remain pending the separately
dispatched private report; completed generation and Word export remain unverified.

## November 3 — cited extraction locators are distinct from factual quantities

The private exact-job diagnostic identified the same numeric citation rejection
in all three retained verifier reports: a paragraph range and table reference
matched the cited frozen source's structural markers but were treated as
unsupported business quantities. The numeric validator now recognizes only
explicit paragraph/table references whose canonical extraction markers occur
in both that cited source's frozen locator and its supplied text. Every member
of a range must exist in one cited source. Preceding anchors, character offsets,
uncited sources and generated metadata grant no exemption. Full quoted
extraction markers, including row/cell coordinates, cannot prove a factual
quantity. All surrounding prices, quantities and dates retain numeric checks;
exact quotations, coverage, candidate hashes and old prompt pins are unchanged.

Local verification: **153 tests across the grounding and structural-reference
suites pass**, including Arabic/Persian digits, malformed identifiers/ranges,
missing range members, uncited metadata and coordinate-number laundering.
Backend typecheck passes. Independent review found and verified the full-marker
coordinate fix. Private offline replay validates the actual writer and all
three retained verifier report structures against the exact frozen evidence
and candidate hash. It does **not** establish acceptance: the corrective report
still marks the source-block check insufficient despite explaining a valid
empty inventory for reference material. The zero-defect acceptance guard stays
intact. No report, usage receipt, budget, pin or production state was rewritten;
deployment, completed generation and actual Word export remain pending.

## November 3 — analysis verification checks source extraction, not proposal fulfillment

New analysis-verifier phases pin verification policy revision 4. Its typed
coverage contract identifies the scoped IDs as source blocks and distinguishes
faithful extraction from a proposal's fulfillment of buyer obligations. An
explicit flexible-input draft may correctly extract no buyer requirements from
historical or unrelated reference material. Missing requirements in that
material alone do not make the extraction defective. Actual omitted buyer
obligations, lost qualifiers, invented requirements and false attribution still
require an insufficient/contradicted verdict. Citation/source-role guards and
the zero-defect acceptance decision remain unchanged. The stored insufficient
reports are not rewritten or reclassified.

Only new `analyze_chunk` verification and report-correction phases choose this
revision. Existing revision 1–3 pins, including accepted unknown-usage phases,
retain their original wire identities. The typed coverage contract appears
only in revision 4 analysis-verifier envelopes and derives its IDs/draft policy
from the supplied task scope. Existing audit verification retains revision 3;
writer/semantic pins are unchanged. Rollback to a runtime that only understands
verification revisions 1–3 is unsafe after new revision-4 phases have started.

Local verification: **244 tests across eight targeted suites pass**, with
backend typecheck, formatting and whitespace checks. Tests cover Arabic/English
faithful empty extraction, missed real obligations, fabricated quantities,
company/style authority rejection, unchanged retained insufficient verdicts,
phase pinning and byte-identical revision 1–3 system/user payload hashes. The
new policy reaches both synchronous and background provider system messages.
Bounded live Qwen/DeepSeek evaluation of valid reference material and a missed
buyer obligation is being prepared separately. Deployment, fresh real generation
and actual Word export remain unverified by these local tests.

## November 3 — guarded fresh successor after verifier contract diagnosis

The retained corrective report still records insufficient per-source coverage;
its status is preserved. No cache-only acceptance path or ordinary retry/accounting
exception was introduced. The separate canonical successor helper now accepts
an exact failed analysis plan with safe idle queued or retry-wait siblings. Every
job must match its queued analysis step and input hash, have no lease fields or
cancel request, and the plan must still have a matching blocked/failed job.
Completed steps, accepted/committed graph results and even a retained accepted
artifact before thread commit all refuse a new successor.

For this narrower recovery scope, every target reservation or nonterminal unknown
receipt refuses recovery regardless of age. Only an explicit
`PROVIDER_BACKGROUND_TERMINATED` unknown receipt with retained nonempty remote,
project and model identity can pass despite a future deadline. The receipt stays
unknown and its full row fingerprint must remain unchanged. This deliberately
replaces the helper's earlier expired-unknown allowance; existing already-started
idempotent replay is checked before eligibility and remains available. Core
provider, retry, reconciliation and usage guards are unchanged.

The serializable canonical cancel/generate transaction retains exact current
job/usage/document revisions, complete prospective snapshot, requested language,
workflow admission and reviewed runtime checks. It now fingerprints all existing
audit events as well as old attempts, sources, graph results/checkpoints/writes,
prompt pins and budgets; only newly required canonical audit events are added.
Fresh jobs receive distinct identities and their own future phase pins/allowances.
No predecessor allowance, candidate, report, usage or audit entry is rewritten.

Verification: **five successor tests pass**, including the complete-schema matrix
under production ownership. A mixed blocked/queued/retry-wait fixture succeeds
with recent terminal unknown usage and a future deadline while retaining settled
intermediate work, writer/verifier/corrector counts of 1/2/1, pins and all prior
history. Active/residual leases, reservations, nonterminal unknowns (including
expired ones), incomplete remote identity, stale job/usage selections and final
accepted work refuse without partial mutation. Simulated historical audit
corruption rolls back cancellation and generation. Independent review and diff
whitespace checks pass. No production mutation was performed by this change;
activation requires the new runtime/live prompt checks and a fresh exact private
inspection, followed by separately recorded generation/export acceptance.

## November 3 — code-only model validation runtime release boundary

The prepared `deploy-model-validation.yml` workflow verifies both locked packages
and all operational/deployment guards before manual deployment. Branch pushes
run offline verification only. The runtime build copies the full functions tree,
including the structural-reference module and verification revision 4, and binds
the image to the workflow source revision and immutable registry digest. The two
earlier AI migration source checksums remain fixed; this release performs no SQL,
database connection, schema/ledger write, provider activation or processing retry.
Private production history evidence belongs to the separate read-only inspector.
Retries reuse the existing commit image only after validating its source label;
an explicitly selected immutable candidate also requires matching source and
digest. Registry lookup errors never trigger a replacement build. This preserves
the exact candidate needed to finish an interrupted rollout without rollback.

`model-validation-update.py` requires the reviewed `2b3391…` API/worker baseline
or the exact candidate on forward completion, and the `b90ee4…` frontend image.
It retains all other deployment identities/specifications, secret values, public
configuration and native schedules. API readiness precedes a guarded temporary
worker `Recreate` strategy, preventing old workers from reading newly durable
verification-4 pins. A candidate-bound metadata marker permits exact partial
release recovery. The old runtime already handles SIGTERM by rejecting new
requests and awaiting its active handler; the release requires at least 240
seconds of termination grace, exceeding its 120-second provider-request bound.
No force deletion is used. After worker readiness, old-process drain and public
acceptance, the original strategy is restored and only the owned marker removed.
Failures retain compatible code; reverting to the old verification-1–3 runtime
after revision-4 admission is deliberately prohibited.

Sixteen focused offline release tests pass, covering API-before-worker ordering,
temporary strategy ownership, failed/ambiguous patch forward completion, baseline
and grace rejection, concurrent configuration/UID drift, unchanged migration
sources, absent privileged HTTP identity, forbidden SQL/admin paths and immutable
image reuse. Independent reviews found and resolved fresh-worker baseline adoption
and late runtime drift: the worker image patch now remains bound to the original
UID/specification, and both runtime identities/images/specifications are checked
after public acceptance and strategy restoration. Both reviewers approved the
final implementation and independently repeated the focused release tests.

Final local operations verification passes **250 tests**, including the sixteen
release cases. Frontend verification passes **269 tests**, typecheck and build;
backend build and **13 deployment renderer tests** pass. The prompt-change owner
separately recorded the full **1,686-test backend pass**, followed by the final
40 affected tests and typecheck after the last parser-boundary tightening. All
diff whitespace checks pass. Bounded live model acceptance and production
deployment remain separate pending evidence; this entry claims neither.

## November 3 — model validation fixes deployed and live policies verified

Live suite `41560518462` on `0437332` passed all four configured QwenCloud
requests (Qwen3.8 and DeepSeek, two cases each): faithful reference-only empty
inventory accepted and actual omitted buyer obligations detected. Production
schema/evidence validation and task-specific assertions ran before success.
Exact prompt hashes and report checksum were independently verified; usage
was measured for all four HTTP 200 calls (18,783 input / 2,097 output tokens),
with zero extra attempts, polling, unknown usage or business records. The
private report transport object was deleted after verified download.

Code-only release `41561808302` passed on
`af3b086b0353d2c85115762a2ae20813e05001b9`, publishing runtime
`sha256:871c2f80e9b2241bf53268b0b9d867ea5c46f4f355da822c7c9ec516b1fe59fb`.
Remote verification passed 1,689 backend tests, 269 frontend tests, 250 ops
tests, 13 renderer tests and both packages' typechecks/builds. API and worker
readiness, graceful old-worker drain, restored strategy, removed release marker
and final exact runtime identity checks passed. Frontend `b90ee4...`, public
configuration, provider assets and all other workloads were preserved. There
was no database access, schema change or processing retry by this release.

Pre-release inspection `41560942476` observed one committed analysis sibling,
two blocked jobs and additional unfinished/uncertain requests in the same plan.
The whole-plan successor helper is therefore not activated: its completed-work
and unresolved-request guards intentionally refuse that state. Existing paid
records remain unchanged. A separately reviewed exact failed-step verifier
recheck is being prepared; no such operation has been deployed or activated.
The actual proposal version and Word export remain incomplete.

## November 3 — one failed analysis step may request fresh verification

Implementation adds a private, Owner-authorized `generation.verifier_recheck`
operation for an idle failed analysis step whose sole writer has a successful,
settled receipt and an exact retained candidate. It creates one distinct child
step/job in the same plan, marks the selected parent step as replaced using the
existing split representation, and cancels only that idle parent job. The audit
identifies verification rechecking explicitly. Normal stage aggregation excludes
the replaced parent and includes its completed child once. Completed siblings,
old writer/verifier artifacts, checkpoints, prompt pins, candidate budgets,
attempts and all usage rows remain unchanged; terminal unknown usage is never
settled or zeroed. Any reserved or nonterminal unknown usage on the selected
parent refuses admission. Other siblings keep their own processing state.

The private lineage table binds the original and child job/step/thread, graph
input, candidate record hash, logical candidate hash and unique successful writer
receipt/attempt. Both old verifier phases must carry an earlier policy revision;
a parent already using revision 4 cannot receive another allowance. The child
gets only verification revision 4, three verifier candidates and one report
format correction. It cannot resend or repair the writer. Database guards enforce
those limits independently of runtime branching across graph budgets, catalog
and legacy routing/attempt/reservation/resume entry points. New reservations
require the exact child phase, seeded original candidate, immutable revision-4
pins, prepared request identity and a request hash different from every parent
request. A missing/corrupt lineage, candidate or cache entry fails closed. Normal
source/currentness, membership, content policies and grounding validators remain
authoritative; a genuine finding stops this child for review.

The new authorization timestamp applies only to this requested child. The old
plan-wide processing receipt and every sibling's receipt remain untouched. The
lineage uniquely permits one child per parent across idempotency expiry or new
keys and excludes rechecking a verifier-only child. Restored jobs retain their
marker and are canceled by the existing restore process; missing private lineage
cannot silently turn such a job into an ordinary writer.

The `recheck-proposal-verifier` workflow is manual for production, defaults to a
canonical transaction with full rollback, and requires explicit `recheck`
activation under the production mutex. Exact private selections and receipts use
the existing encrypted transfer. The helper validates both runtime images before
SQL and fingerprints historical siblings/accounting/graphs/source records around
the canonical operation. It performs no direct business row rewrites. Public
logs contain only fixed status/count and the encrypted report's plaintext digest.

Final focused verification passes **94 tests** across canonical admission,
provider/graph guards, the exact compiled operations wrapper and runtime replay,
plus **six historical provider-migration compatibility tests** and **six private
transport tests**. The canonical suites include same-config/different-config verifier
telemetry, full rollback after silent completed-sibling corruption, and rejection
of reused parent request hashes. Another **161 existing catalog, routing,
permission and graph tests** pass. Backend typecheck, formatting and diff checks
pass. Independent SQL and operations review passed. The release helper also
passed exact migration apply/replay under the restricted `tdp_app_owner` with
all legacy role names absent, preserving old rows and authority and creating
zero children; mutation and unexpected-grant cases rolled back. Local
operations fixtures adapt the database name and role; production check mode is
still a separate acceptance step.

The immutable OpenRouter provider migration deliberately refuses a newer
function body containing the verifier-only guard. Its repeatability test now
runs at that migration's original schema boundary, and a second test proves
that replay on the latest schema refuses without changing data or guarded
function definitions. No historical migration hash or allowlist was changed.
New verifier metadata counts the retained parent's model configuration when
reporting same-model verification; historical attempts remain untouched. The
new migration supports either legacy or managed role names using conditional
ACL revocation and does not alter existing role membership. This entry does not
claim deployment or activation, actual proposal completion, or Word export.

Pre-activation review removed a false conflict caused by the shared plan
revision: completing a sibling legitimately advances that revision while the
selected failed job, step and candidate remain unchanged. The inspected and
observed plan revisions are retained in the audit. Exact selected job/step
revisions, latest-plan identity, active status, analysis stage, proposal base
version, current source checks and all accounting/lineage guards remain required.
Admission and every child binding also recompute the full frozen-context hash
against the immutable plan input hash. A full-schema test completes a sibling
through the canonical callback and then admits exactly one recheck child while
preserving that completed sibling. Canceled/failed/advanced plans and changed
input or frozen context refuse; existing changed source, latest plan and active
proposal-version negatives remain green. Final focused tests and typecheck pass.

The verifier-only runtime is isolated behind the explicit child checkpoint.
Every lease, including accepted-cache replay, performs a fresh verifier/content
preflight and requires an enabled authorized target. It then obtains the exact
database-authorized parent seed, checks the full frozen graph-input hash and
logical candidate hash, revalidates canonical/domain rules and preserves the
entire original result/producer value. Separate immutable provenance records
the parent; no child writer allowance or synthetic writer receipt is created.
Only the whole-report verifier and its one report correction can reach provider
preparation or token counting. New verification/semantic pins must both be 4.
No ordinary writer repair, batch-budget expansion or historical-report recovery
is available. Real defects and a failed corrective report remain retained and
stop durably for review; accepted results still pass the standard grounding and
generation-completion callbacks.

Runtime verification: **22 unit/integration tests pass** against the fully
migrated synthetic database. They cover interrupted seed/checkpoint replay,
accepted-cache replay and corrupted reports, later permission revocation,
disabled targets, malformed/stale lineage, exact producer/source coverage,
zero writer calls/budgets/token counts, one fresh report correction, preserved
parent receipts/results/budgets and normal child-step completion. Backend
typecheck passes. Ordinary graph, writer-handoff and invalid-verifier recovery
regressions also passed in the targeted run. Full-suite verification and final
independent review are in progress; no production child was activated by these
tests.

## November 3 — reviewed verifier-recheck runtime and single-migration release

The prepared deployment is separate from requesting a verifier recheck. It builds
or reuses one source-bound immutable API/worker image, requires current runtime
`871c2f80…` (or that exact candidate on partial recovery), and preserves frontend
`b90ee4…`, all unrelated deployment identities/specifications, public configuration,
provider secrets and native schedules. The API becomes ready before a guarded
worker Recreate transition; old workers finish their existing graceful shutdown
before new workers are admitted. Ordinary unmarked jobs use their original runtime
path before the migration, and deployment never creates or activates a child.

The exact migration is `20261103022500_analysis_verifier_recheck.sql`, SHA-256
`cead30c43776e35822e4fa63476223a5ff4abe8de35218286d66dd5bd8c22382`.
After runtime readiness and old-process drain, a restricted-owner transaction
checks the prior AI release receipt, snapshots every pre-existing public/private
row and existing table/function authorities, applies only this source, and records
`analysis-verifier-recheck-v1` with its checksum. Existing function bodies outside
the fourteen reviewed targets also remain unchanged. The only new schema is the
empty private lineage table and five private functions; RLS, direct grants,
browser denial, function ownership/search paths and expected guard markers are
verified. No paid receipts, unknown usage, budgets, completed siblings or frozen
work are reset. A repeated identical release verifies the ledger and schema;
checksum drift or untracked schema is refused.

Successful acceptance restores the exact worker strategy, removes its owned
rollout marker, rechecks both runtime identities/images and preserved resources,
and removes its temporary SQL administrator before emitting final success.
An ambiguous image or SQL outcome retains compatible code and requests forward
completion with the same immutable candidate. It never rolls back code across
possible new child admission or clears migration history. Manual deployment is
the only workflow path with production credentials; branch pushes run offline
checks only. Recheck activation remains a separately scoped canonical operation.

Seven focused release tests pass, including the exact complete-schema migration
under restricted `tdp_app_owner` with only managed role names, idempotent replay,
empty lineage, existing-row/grant mutation rollback, rollout/schema ordering,
ambiguous failure retention, foreign administrator refusal and cleanup failure.
Final local operations verification passes **263 tests**, and all **13 deployment
renderer tests** pass. The seven exact-migration release cases were repeated
successfully after the final `cead30c4…` plan-revision refinement. Independent
review approved the release sequence and
separately repeated the seven focused cases. Two historical operational fixtures
now load their actual predecessor migration boundary; historical SQL and hashes
remain unchanged. Frontend **269 tests** and both package typecheck/build checks
passed in the runtime workstream. The final complete backend suite remains a
required workflow gate before production deployment. This entry does not claim
production deployment or child activation.

## November 3 — refreshed exact-runtime graph inspection

The read-only graph diagnostic now accepts an explicitly selected immutable
runtime digest in the owned TenderDesk registry, instead of fixing the earlier
image in its selector. The existing three runtime checks still require both API
and worker to match that exact digest before client preparation, before the SQL
read and before private report publication. Tags, other repositories, malformed
digests and missing workflow source revisions fail closed. The private report
records the diagnostic source commit; source and candidate content remain inside
the encrypted report transport. The SQL remains unchanged and read-only.

Nine offline diagnostic tests pass, including the exact SQL against the complete
schema under the restricted application owner, no record changes, a newer digest
through all three guards, drift refusal before SQL/publication, and bounded public
receipts. This prepares a fresh post-deployment inspection; it does not dispatch
inspection, authorize a stale selection, or change business state.

## November 3 — private inspection of workspace model capacity and dispatch

The existing proposal inspector now reads bounded workspace execution metadata
alongside the selected proposal. It reports the configured/effective parallel
request limit, exact reserved/running counts, up to 64 reserved request owners
and running jobs, safe lease/deadline flags, queue work-class due counts,
scheduler heartbeat, dispatcher timestamps and fairness cursor. Selected jobs
also expose a small checkpoint projection, latest attempt diagnostics and both
semantic and verification policy versions. This can distinguish an outside-plan
accepted request occupying capacity from a stopped dispatcher or future-due
proposal continuation without claiming that raw due counts prove eligibility.

The transaction remains repeatable-read and read-only. The optional Kubernetes
outbox is queried only if its table exists, using the exact installed runtime
schema. No claim, wake, polling, authorization, model or business mutation is
invoked. Remote request IDs, lease tokens, dispatcher secrets, routing secrets,
provider payloads and customer/source text are excluded. All added metadata
uses the existing encrypted private report; public receipts remain unchanged.

Twenty focused inspector/successor/observer tests pass. The expanded synthetic
full-schema fixture covers absent and present runtime outbox installations,
a reserved request owned by another assessment, live worker leases, due work
with supported/unsupported executor versions, private checkpoint/HTTP/lease
sentinels, and byte-for-byte preservation of queue/accounting/operations rows.
Independent source review found no blocker. Diff checks pass. This is an
operations inspection change only; no runtime, migration, business logic,
production query or provider call was changed or executed by these tests.

## November 3 — verifier-recheck release deployed; activation remains pending

[Deployment workflow 41566561043](https://github.com/salahassi/tenders/actions/runs/41566561043)
succeeded for source `4ab0790c04a00e903733df1c29ec3846ef04ac4a`. Both API and
worker now use immutable runtime
`sha256:bded9f019592be84ae45e078d55a52e438c3f6942b2bd1bf35d148d4ff0d6c4a`.
API readiness was confirmed at 02:41:21 UTC and worker readiness at 02:41:32 UTC.
Old workers drained before schema application; the exact worker strategy was
restored and its rollout marker removed. Final acceptance and temporary
administrator cleanup completed at 02:42:14 UTC.

The applied migration `20261103022500_analysis_verifier_recheck.sql` has SHA-256
`cead30c43776e35822e4fa63476223a5ff4abe8de35218286d66dd5bd8c22382`, recorded
under release ledger key `analysis-verifier-recheck-v1`. Acceptance confirmed
preserved pre-existing rows and authorities, configuration and other workloads,
and unchanged frontend image
`sha256:b90ee4cea47e8208dd785aba618caaf89aadf3c8fd15e4c8172633b2883b88af`.
Deployment created zero recheck children and retried no processing. Source and
schema application are complete; production recheck activation and proposal
completion remain pending separate evidence.

The deployment gates passed **2,332 tests**: **1,785 backend**, **269 frontend**,
**265 operations** and **13 renderer** tests, plus both package typecheck/build
checks. These final workflow results supersede the earlier pending full-suite
status.

The metadata-only diagnostic source `942c6c6acfd9ec2d89945ce65c0b4877056b4729`
was inspected successfully by
[workflow 41567339637](https://github.com/salahassi/tenders/actions/runs/41567339637).
That read-only snapshot showed effective model capacity of two requests, one
reserved request and a healthy scheduler. Capacity was not full in that
snapshot; these observations do not establish the root cause of the remaining
processing delay or prove that the selected continuation was eligible to run.

## November 3 — preserve model admission fairness across accepted polling

A fully migrated synthetic reproduction identified a queue starvation cycle:
with two model slots, one long accepted request and repeated background arrivals,
background admission plus accepted polls repeatedly returned the shared six-slot
cursor to background. Eight cycles admitted eight background requests and served
sixteen polls while an eligible proposal continuation received zero attempts.
The proposal was immediately claimable when the cursor changed. This is a local
real-claim-RPC reproduction; production metadata alone did not establish the bug.

New additive migration `20261103032000_model_admission_fairness.sql` introduces
private workspace model-admission state independently of the existing local/poll
cursor. An eligible preferred business class retains its next admission until
it actually claims capacity-requiring work. When it has no eligible model work,
the other class proceeds. Only new model work consumes this turn; accepted polls,
local transitions, source collection/candidate processing, notice fetches and
cancellation do not. Proposal/background admission remains the existing tested
one-to-one policy. The original six slots, owner/deadline ordering, due/executor/
OCR/dependency checks and workspace lock remain intact. Eligibility uses the same
installed predicate in both selections. An unrelated row lock can conservatively
delay a claim without consuming credit; ordinary claimants already share the
workspace lock. Existing jobs, accounting, graph histories and cursor rows are
not rewritten by the migration. New state is initialized lazily and has RLS
enabled with no browser/service grants.

All **163 tests across seven focused queue/worker suites** pass, including eleven
new regressions. The exact cycle now serves the waiting proposal after capacity
returns for both known terminal-unknown and settled fixture outcomes, retaining
remote identities and the long-running reserved receipt unchanged. Tests also
cover limits one/two, continued polls/local work while full, unchanged local-only
cursor/admission credit, capacity-free exemptions, absent/ineligible preferred
classes, and private-state permissions. Existing source/OCR, owner, continuation,
dependency and future-due regressions remain green. Backend typecheck and diff
checks pass. SQL SHA-256 is
`3bb13dd60fb4322ac3ba70c534ec6165a668da547318d1ea49232ae1d401c927`.
Deployment and hosted progress remain pending; these tests made no live calls.

## November 3 — atomic SQL release for recheck identity and model admission

A SQL-only release is being prepared for the additive prompt-identity correction
`20261103031500_analysis_recheck_prompt_identity.sql` and queue-fairness change
`20261103032000_model_admission_fairness.sql`. It requires the deployed `bded9f…`
API/worker image, unchanged `b90ee4…` frontend and the prior verified AI/recheck
release receipts. It obtains cluster/database access without building images or
requesting registry push credentials. No rollout, direct job claim, wake, retry or
child activation is part of the release. After the transaction commits, the
existing scheduler may advance already eligible queued work using the corrected
admission rule.

Both exact sources apply in one restricted-owner, repeatable-read transaction.
Only `analysis_recheck_binding(uuid)` and `next_fair_job(uuid,boolean)` may change;
the new private admission cursor must initially be empty. Every pre-existing
public/private row, existing function authority and unrelated body, table
authority/structure, policy and role membership is checked for preservation.
Separate source-checksum receipts commit together; partial batch receipts and
checksum drift refuse. An identical replay preserves a cursor subsequently used
by the ordinary scheduler. Existing runtimes, all deployment identities/specs,
configuration and schedules are checked before SQL and after public acceptance
and administrator cleanup. Ambiguous SQL acknowledgement requires verification
or replay of the same batch, with no runtime rollback or accounting reset.

The frozen identity source SHA-256 is
`30f79868deaa94daab1554584aede2545a1611a29f7b19d26503e75f57720f14`, with
ledger key `analysis-recheck-prompt-identity-v1`; the frozen fairness source is
`3bb13dd60fb4322ac3ba70c534ec6165a668da547318d1ea49232ae1d401c927`, with
ledger key `model-admission-fairness-v1`. The earlier `cead30c4…` migration and
receipt remain unchanged.

All **eight release tests pass**, including the exact batch under restricted
`tdp_app_owner` with only managed role names, atomic rollback of both migrations,
row/authority/structure preservation, partial-receipt refusal, cursor-preserving
replay, immutable workload checks and administrator cleanup. An independent
reviewer approved the wrapper/workflow and repeated the eight tests successfully.
The full local operations suite passes **273 tests**, and all **13 renderer
tests** pass. Both application packages retain their full typecheck/test/build
gates in the manual release workflow. Production application and actual proposal
recovery remain separate, pending evidence.

## November 3 — prepared code-only release for typed verification

The typed-verification release uses a small adapter around the audited
`model-validation-update.py` rollout. Its baseline is the deployed `bded9f…`
runtime, with a distinct `typed-verification-code-v1` receipt and owned worker
transition marker. It retains frontend `b90ee4…`, other workloads, configuration
and schedules. All five previous migration source checksums are checked locally;
the updater opens no database connection and makes no processing request.

The existing immutable-image helper builds once or reuses the same verified
source/digest. API readiness precedes the guarded worker Recreate transition;
graceful old-worker termination prevents mixed readers of newly admitted format
pins. Candidate acceptance restores the exact worker strategy and waits for its
controller acknowledgement before the final identity/specification checks. Any
ambiguous rollout retains compatible candidate code for exact-image forward
completion. The ordinary backend Docker copy includes newly imported shared
modules without changing frontend assets.

Five focused adapter tests pass, reusing the existing JSON-patch simulator and
spies that reject database/admin calls. They cover the exact baseline and unique
marker, prior-source integrity, unchanged unrelated workloads, strategy readiness,
partial candidate replay and foreign-state refusal. The separate workflow permits
production access only on manual dispatch and retains full package and operations
gates. Independent release review approved the adapter/workflow and repeated all
five tests successfully; the eleven shared rollout tests also pass. Typed-format
runtime verification is recorded separately. Bounded live evaluation and final
release workflow gates remain pending; this entry does not claim runtime deployment.

## November 3 — immutable writer prompt identity correction

[Production check 41568178446](https://github.com/salahassi/tenders/actions/runs/41568178446)
refused with `MODEL_RECHECK_IDENTITY_CHANGED` and zero activated children or
model calls. The deployed admission guard incorrectly expected an
`analyze_chunk.*` prompt identifier. The actual task registry emits
`tenderdesk-v3.evidence-v1.tenderdesk-semantic-fidelity-v1.economy-v1` for the
retained semantic-four writer. Reconstructing the private frozen request through
the real `taskInput` and `modelPrompt` functions exactly matched the paid request
hash. No customer identifiers, prompt payload or source content are included in
the regression fixtures or this checklist.

The previous synthetic fixture invented the same incorrect prefix and therefore
missed the defect. It now derives both writer identity and request hash from the
production prompt builder, and saves the actual semantic-four phase policy.
Against the exact previously deployed migration boundary, this corrected fixture
reproduced the production refusal. The additive migration
`20261103031500_analysis_recheck_prompt_identity.sql` replaces exactly that
predicate, also requiring the immutable semantic-four writer pin at the exact
candidate phase. It preserves all other source, receipt, producer, graph,
candidate, prior-verifier and single-writer admission checks. The already deployed
migration, historical accounting, reports and budgets are not rewritten.

All **98 full-schema recheck tests** across six suites pass with the correction,
including restricted production-role execution, history preservation and
writer-path denial. The 15 focused correction tests prove the deployed-boundary
refusal, additive repair with every application table and existing authority
unchanged, and atomic refusal of fabricated/legacy prompt identities, missing or
wrong writer phase/revision, corrupted pin content/hash and a mismatched paid
request hash. Backend typechecking and formatting checks pass. Independent prompt
and provider reviews found no blocker. The correction SQL SHA-256 is
`30f79868deaa94daab1554584aede2545a1611a29f7b19d26503e75f57720f14`;
the deployed migration retains its original `cead30c4…` checksum. Production
application and actual recheck acceptance remain pending the separate reviewed
SQL release.

## November 3 — bounded typed-analysis authority evaluation

The manual evaluation workflow now offers `analysis_authority`: exactly the
configured QwenCloud `qwen3.8-max` and `deepseek-v4-pro`, each with two synthetic
cases and at most four generation requests total. Both cases use the same buyer
brief and candidate prose. The valid case retains an optional workshop and an
advisory question about an absent formal RFP; the invalid case changes only the
typed mandatory flag and question blocking level. The negative golden assertion
requires a source-associated finding of optional scope strengthened into an
obligation; a generic missing-RFP objection alone cannot pass.

Fixtures construct their context through the real `verificationContext` format
pin, using ephemeral local state with no database or provider access. New format
3 retains the exact structured candidate while semantic and verification policies
stay at revision 4. Actual adapter calls run canonical `validateGroundingReport`
before success, then the selected golden assertions. Existing request bounds,
strict target/pair selection, usage reporting, secret redaction and encrypted
private report transport remain in force. Push events run offline checks only;
live requests still require explicit manual activation.

All **25 evaluation harness tests**, **18 Python boundary tests** and **8
full-schema catalogue tests** pass, along with backend typechecking and formatting
checks. All **58 historical live-request prompt hashes** across the five existing
suites remain identical. Independent review verified the four-request boundary,
production format/validation path and private transport. The semantic assertion
also accepts an unsupported mandatory flag tied to a quotation establishing
optional scope, while rejecting a mere omitted-optional-work or missing-RFP
finding. The later live outcome and its provider-specific limits are recorded
below; preparing this suite itself sent no model requests.

## November 3 — typed analysis verification formats

New whole-analysis verification pins context format **3**, retaining the exact
structured candidate alongside its existing content units. Mandatory booleans,
null owner questions, question blocking levels and their JSON field ownership
are now visible to the verifier. The redundant flattened candidate text is
removed. Historical format **1/2** prompts retain their exact recorded bytes;
an accepted unpinned legacy request keeps its original context until retrieval
completes. Semantic and verification instructions remain unchanged.

New batched analysis uses a separately pinned **version 5** envelope declaring
context format 3 around the unchanged version 3/4 partition policy. Each scoped
request receives the typed candidate while the existing selected content units,
required IDs and candidate hash remain the exclusive report coverage boundary.
Old batch pins keep their exact payloads. Output partition sizes, graph budgets,
writer repair and the single-candidate verifier-recheck authorization are
unchanged. Existing input-token admission still applies to the larger typed
context; seeing the typed fields does not guarantee a correct model verdict.

**261 tests across 8 backend suites** and backend typechecking pass. Regression
coverage includes historical whole/batch prompt hashes, opposite mandatory flags
with identical prose, null/false values, malformed format identities, accepted
legacy requests, corrective reports, and rejection of out-of-scope quotations,
extra coverage IDs and a wrong candidate hash. Four full-schema graph cases
exercise new and historical batch formats with/without output-token policy
across leases, preserve one writer and exact usage counts, and merge complete
coverage. Independent review passed another 152 focused tests and all four
durable cases. These offline checks performed no production model calls or
deployment. The later bounded authority result is recorded below; runtime
deployment remains a separate gate.

## November 3 — recheck identity and admission SQL deployed

[Workflow 41569680096](https://github.com/salahassi/tenders/actions/runs/41569680096)
completed successfully for source `141d1c6625b4f7b086da6a0a0b72cfb1a6414cc4`.
Its full gates passed **2,366 tests**: **1,811 backend**, **269 frontend**, **273
operations** and **13 renderer**, plus both package typecheck/build checks.

The atomic batch was verified at 03:11:33 UTC. It applied identity migration
`20261103031500_analysis_recheck_prompt_identity.sql`, checksum
`30f79868deaa94daab1554584aede2545a1611a29f7b19d26503e75f57720f14`, and
fairness migration `20261103032000_model_admission_fairness.sql`, checksum
`3bb13dd60fb4322ac3ba70c534ec6165a668da547318d1ea49232ae1d401c927`, with
their separate checked release receipts committed together. Existing rows,
authorities and structures were preserved. Temporary administrator resources
were removed at 03:12:09 UTC; final acceptance and runner cleanup completed at
03:12:11 UTC.

API/worker runtime remained
`sha256:bded9f019592be84ae45e078d55a52e438c3f6942b2bd1bf35d148d4ff0d6c4a`
and frontend remained
`sha256:b90ee4cea47e8208dd785aba618caaf89aadf3c8fd15e4c8172633b2883b88af`.
No deployment image/specification or retained configuration changed. The release
invoked no job claim or processing retry and created no recheck child. Fresh
canonical recovery admission, actual generation completion and typed-format
runtime deployment remain separate acceptance steps.

## November 3 — typed-analysis authority live result: DeepSeek passed; Qwen quota blocked

[Evaluation 41570661661](https://github.com/salahassi/tenders/actions/runs/41570661661)
ran source `6e50aaae23182a7307f5a8a4cff57d0239e3579d` and completed exactly
**four generation POSTs**, one for each permitted model/case pair, with no polls
or additional requests. All four prompt hashes match both the saved pre-dispatch
expectations and the current production prompt builder. The verified private
report SHA-256 is
`d1908355f955058ab88924c9467ce95a7f97a75f232764a63a4ec88547bcd307`.

**DeepSeek passed both semantic cases** with HTTP 200: it accepted the faithful
optional scope and detected optional scope incorrectly promoted to mandatory.
The executed harness requires canonical `validateGroundingReport` before attempt
success and the source-associated golden assertions before case success. The
receipt confirms both gates passed; successful response bodies were not retained,
so this review verifies the executed gates and request identities rather than
replaying the successful response payloads offline.

**Both Qwen3.8 requests were rejected with HTTP 403 before a candidate was
returned.** Provider details report `insufficient_quota`, reason `usage_limit`,
and exhausted free quota under the provider's free-tier-only setting. The adapter
classified these as `PROVIDER_AUTH_FAILED`; they are provider quota failures,
not evidence of a wrong semantic verdict. Qwen's two new authority cases remain
unevaluated. The aggregate result is **two passed cases out of four attempted**,
not a four-case pass.

Measured DeepSeek usage totals **9,823 input and 1,429 output tokens**. Both
Qwen input/output values remain null, giving **two cases with unknown usage**;
no missing measurement was converted to zero. All cases report cleanup
`not_needed`, and no application records were created. No rerun, payment change
or provider configuration change followed this review. This bounded adapter and
prompt result supports the selected DeepSeek behavior; actual proposal workflow
completion and Qwen authority verification remain separate acceptance limits.

## November 3 — typed verification runtime deployed

[Deployment 41571450550](https://github.com/salahassi/tenders/actions/runs/41571450550)
succeeded for source `6e50aaae23182a7307f5a8a4cff57d0239e3579d`. Its complete
gates passed **2,404 tests**: **1,841 backend**, **269 frontend**, **281 operations**
and **13 renderer**, plus both package typecheck/build checks.

API and worker now use immutable runtime
`sha256:85799a61eaeed29f967f51fc7c9c83263d07e28c9053941663a396604ae60380`.
API readiness was confirmed at 03:29:47 UTC and worker readiness at 03:29:58 UTC.
The old workers drained before new-worker admission. The exact worker strategy
was restored, its owned marker removed, and controller readiness acknowledged
at 03:30:09 UTC. Final acceptance and temporary runner cleanup completed at
03:30:11 UTC.

Only the API/worker runtime images changed. Frontend remained
`sha256:b90ee4cea47e8208dd785aba618caaf89aadf3c8fd15e4c8172633b2883b88af`;
configuration, schedules and other workloads were preserved. The release checked
all prior migration source hashes, opened no database connection, changed no
schema and invoked no processing retry. Actual proposal completion and Qwen's
quota-blocked authority cases remain separate acceptance limits; the deployed
runtime supports existing format pins as well as the new typed formats.

## November 3 — canonical verifier recheck activated; completion still pending

[Check 41570878980](https://github.com/salahassi/tenders/actions/runs/41570878980)
passed the canonical operation inside a rolled-back transaction and retained zero
children. [Activation 41571204939](https://github.com/salahassi/tenders/actions/runs/41571204939)
then created exactly one verifier-recheck child. Both receipts bind verification
revision 4, **zero writer allowance**, at most **three verifier candidates** and
**one verifier-format correction**. The parent writer, old artifacts, pins,
budgets and accounting remain retained; the checked history fingerprint was
preserved. Activation does not mean the new verification has run or passed.

[Observation 41571512040](https://github.com/salahassi/tenders/actions/runs/41571512040)
timed out after twenty read-only samples, with its final snapshot at 03:25:11 UTC.
It demonstrated actual post-fairness progress: one formerly stalled continuation
advanced from four to ten attempts and entered a scheduled round-exhausted wait;
another queued analysis ran and stopped at `USAGE_REVIEW_REQUIRED`. The explicit
recheck child remained queued with zero attempts, no model usage and no graph
thread. No final proposal version or Word export was ready.

The unchanged ordering within this proposal owner puts six older queued siblings
and one overdue round-exhausted continuation ahead of the newly created child.
A fully migrated local reproduction using the actual claim RPC confirms that
order while the plan remains blocked. Polls and retained graph continuations can
interleave, so this observation does not establish a child start-time guarantee.
The new usage blocker follows a paid repair result rejected for invalid evidence
while an earlier accepted request retains unknown usage. Exact phase attribution
awaits its private graph diagnostic; the accounting guard remains intact. All
48 existing writer-handoff integration tests pass, including preservation of
usage, candidate budgets and checkpoint state when same-phase unknown accounting
blocks progress. No reprioritization, cancellation, budget reset or usage rewrite
was performed. A further bounded observation under the newly deployed typed
runtime and the private diagnostic are pending separate acceptance evidence.

The exact private diagnostic from workflow
[41572919737](https://github.com/salahassi/tenders/actions/runs/41572919737)
confirmed that the unmeasured OpenAI receipt and the paid DeepSeek repair share
both the request hash and repair phase. OpenAI explicitly terminated with
`credit_balance_exhausted`; its usage remains unknown. Replaying current canonical
validation against the frozen evidence still rejects both retained candidates
for source quotation mismatch. The DeepSeek HTTP 200 therefore does not establish
valid repaired content. No accepted result or completed handoff exists. Existing
canonical actions cannot complete this part without genuine usage reconciliation
and a valid bounded correction; no accounting or validation guard was overridden.

[Post-deployment observation 41572780456](https://github.com/salahassi/tenders/actions/runs/41572780456)
verified runtime `85799a61…` through twenty read-only samples. At 03:38:02 UTC,
the same plan had one succeeded job, two blocked jobs, four scheduled/pending
retries, five queued jobs and the retained canceled parent. Further older queued
parts had entered real model processing, and one accepted request was active.
The explicit verifier-only child was still queued with zero attempts, usage or
graph artifacts. The plan remained blocked with no proposal version; full
generation and actual Word export did **not** pass acceptance. The native queue
remains enabled; no priority changes or extra child requests were made.

Remaining provider limits are distinct from code deployment: Qwen3.8's free-only
quota is exhausted, and OpenAI reports exhausted credit. DeepSeek passed both
bounded authority evaluations, but some real retained analyses still fail exact
evidence validation. The Qwen HTTP 403 is internally labeled as an authentication
failure while its recorded reason correctly says provider usage limit; this
display/classification follow-up does not disable the shared connection or block
DeepSeek failover. No billing, credential, quota-mode or content-permission
settings were changed to bypass these limits.

## November 4 — W02 readable-page retention and typed upload disposition (implementation slice)

Scope: F03's whole-document omission and F02's typed rejected-input handoff.
The PDF extractor now records versioned per-page coverage, retains readable
pages around blank/scanned/failed pages, and distinguishes confirmed blank
pages from textless pages requiring processing. A single failed page no longer
throws away later readable text. Partial documents retain `status=partial`;
short readable plain text remains readable, and whitespace-only input is not
misreported as a scan. Worker failures retain a bounded input-disposition code
for the separately implemented `delivery.snapshot.prepare` flow; a rejected
original is not inserted as fabricated source evidence.

CLI-generated migration `20261104121022_partial_document_coverage.sql` adds
immutable extraction coverage, checks page identity/count/text lengths/status,
and a service-only acceptance wrapper retaining the original membership,
integrity, idempotency and source hashing checks. Browser completion also binds
coverage to the server-read PDF page count. New draft snapshots include readable
partial RFP and scoped review text, freeze coverage and warn about unresolved
pages. Existing paid snapshots without `extraction_coverage_version` retain
exact prior selection and shape; no prompt/input/receipt is rewritten. Company
Knowledge's existing ready/verified admission is unchanged. Final approval does
not treat partial extraction as complete or confirmed. Expired/restored source
metadata remains historical and cannot authorize current content.

Implementation and focused validation are present; deployment and hosted
acceptance are **not performed** by this slice. Focused tests cover mixed pages,
page-read failures, a real synthetic PDF through the pinned PDF.js Node-compatible
parser/worker, completion transport, metadata round-trip, fully migrated SQL
admission/replay/legacy input preservation, revocation rollback and private RPC
permissions. Final package checks are recorded after completion below.

Remaining W02: actual durable OCR execution for private uploaded originals,
source-linked OCR successor ingestion, hosted upload/download acceptance and
full page-coverage quality measurement. No OCR provider calls, fake OCR text,
production changes or customer document fixtures were used. Empty/corrupt
input's persisted independent template belongs to the delivery implementation;
typed errors alone do not close F02 or the complete W02 package.

Final local package checks for this slice: backend typecheck/build and **1,853
passed tests across 112 files**; frontend typecheck/build and **282 passed tests
across 42 files**. Earlier runs exposed one old HTTP mock's extra undefined
argument and Node compatibility requirements in the new real-PDF test; both
were corrected and the complete package suites rerun successfully. The real-PDF
fixture uses the pinned PDF.js legacy distribution solely for Node's missing
modern runtime APIs; production continues to use the existing browser build.
Page coverage describes extracted text and unresolved pages, not independent
proof that a page's text layer captures every image, table or buyer obligation.
Original-to-extraction fidelity and durable OCR remain separate W02 acceptance.
## November 4 — W08/F09 bounded company-evidence retrieval (local implementation)

The Owner authorized implementation of the reliable proposal delivery plan.
This slice implements RT-01's bounded retrieval behavior for **newly requested**
`draft_section`, `plan_commercial` and `review_proposal` work. It does not mark
all of W08 or RT-02 complete.

`companyEvidenceRetrieval.ts` supplies every verified frozen company source when
it fits the added-context budget, instead of taking only six literal matches and
cropping each to 2,000 characters. All blocks with the same immutable source
identity/hash are admitted together, in their frozen sequence; a later block's
qualification cannot be silently dropped by this selector. When the bounded
payload cannot hold everything, already-cited sources take priority and remaining
whole sources are selected across requirements. Literal matches only prioritize
selection; they never establish semantic support. Source count/byte coverage,
capacity omissions, cited-source coverage and per-requirement retrieval gaps
are explicit. Empty or incomplete retrieval never establishes company capability
absence. Historical style remains separate from verified company facts.

The 24,000-byte company allowance and 48,000-byte context envelope are conservative
application bounds, **not** exact provider token counts or universal context
capacity claims. Existing provider/context checks remain. Oversized sources are
omitted intact with an explicit gap; no automatic secondary model retrieval,
vector platform or arbitrary document truncation was introduced.

CLI-created migration `20261104122015_company_evidence_retrieval.sql` wraps the
existing private draft snapshot function and pins `company_retrieval_version:1`
only for new requests. Historical absent pins and explicit prior pins survive
currentness checks unchanged. The wrapper preserves all delegated snapshot fields,
old rows, jobs, input hashes, source/currentness checks and private ACLs. Existing
paid requests retain their old six-source/snippet behavior and exact prompt input.

Verification: both package lockfiles were installed using `npm ci`. New synthetic
retrieval cases exercise source seven, late evidence, Arabic/English in both
directions, synonyms without literal overlap, equal ranks, requirement-fair
selection, whole-document qualifiers, cited-source priority, capacity exhaustion,
unverified/style controls and unchanged historical task inputs. Seven fully
migrated database cases cover new/old pins, migration-boundary row/job preservation,
source expiry, revoked verification, exact provider-permission revocation for a
newly selected seventh source, and private function privileges. Final checks pass **1,868 backend tests across 112 files** and **269 frontend
tests across 40 files**, plus both packages’ typecheck/build. A final narrow
capacity-loop improvement was rechecked with **66 focused tests across 5 files**
and backend typecheck/build. The new retrieval-specific cases total 27 tests
(20 selector/task-input cases and 7 database cases).

Supabase function security guidance and the relevant database changelog were
reviewed. The migration creates no public table/API or new permissions. Local
`supabase db advisors --local --type security --level warn` could not connect
because no local Supabase server listens on 127.0.0.1:54322; no hosted or retired
project was queried. Private ACL and actual migration queries passed in PGlite;
this is not a hosted advisor/authorization acceptance claim.

Deployment and hosted acceptance: **not deployed; not exercised with live models**.
Company Knowledge permission remains enforced at canonical per-provider preflight;
this change does not silently grant permission or create a provider-specific
filtered candidate pool. Permission failure can still stop AI enrichment and must
remain distinct from invalid RFP input in the delivery workflow. RT-01's broad
semantic recall/precision calibration, automated targeted follow-up for oversized
sources, and RT-02's whole-proposal obligation/annex reconciliation remain open.
## November 4 — W06 bounded reference diagnostics and quote-only correction scope

Implementation: local source change; not deployed or hosted-accepted. The actual
schema-valid task validator now collects independent quote/source-provenance
failures across requirements, verifier claims/checks, reviews, classifications,
planning decisions and draft citations. Analysis/review coverage errors no longer
hide independent quote failures. The retained diagnostic set is bounded to 32,
ordered by field path, with an explicit omitted count carried through candidate
retention, repair-only artifacts and corrective requests. Full validation still
rejects any unresolved reference; overflow is never represented as complete review.

Newly started quote-only correction phases pin a versioned candidate hash and
allowed quote paths. The application composes replacements from the original
candidate and rejects every other change before an invalid response can enter the
paid-writer repair cache. Source IDs, obligations, quantities, array structure and
unrelated text cannot change through this path. Historical paid, prepared and
same-phase saved-round requests keep their exact old context; no prompt, usage,
allowance, permission or provider setting is reset. The existing full-result wire
schema is retained as a proposed patch for compatibility, with strict server-side
scope enforcement. Semantic/source-identity corrections do not silently acquire
quote-only scope or an expanded edit permission.

Validation: both lockfiles installed with `npm ci`; four real-validator regression
cases failed before the change (four defects collapsed into one, coverage hid
quotes, overflow missing) and pass afterward. A pre-validation scope guard test
also failed before implementation. Eleven focused files / 326 tests pass, including
fully migrated graph/SQL handoff, crash replay, pinned semantic requests, canonical
verifier recheck, overflow boundaries, three-of-four correction, wrong source role,
unknown provenance, and out-of-scope obligation/text/source/deletion mutations.
The real graph rejects a scope-violating repair without retaining candidate-1,
accepting it or invoking its verifier. Backend typecheck passes. Broader package
checks remain part of integration; this local evidence is not production success.

Remaining W05/W06 gates: stable source spans and authority semantics; a dedicated
patch wire schema and justified semantic dependency expansion; exhaustive local
validation beyond references/selected coverage; all-task typed verification
(ME-08) with phase-compatible historical hashes; independent semantic/live model
qualification and deterministic artifact delivery. No production or external model
calls were made for this change. Do not mark W05/W06 or T08/T09/T19 complete.

## November 4 — W06 / ME-08 typed verification formats and historical phase compatibility

Implementation: local source change; not deployed or hosted-accepted. Newly
started verification of every business task now preserves the candidate's field
hierarchy, booleans, numbers, nulls, ownership and citation metadata. New whole
requests use format 4; new nonanalysis batches use format 6 with typed structural
references to the existing canonical content IDs. Their complete/scoped ID
manifest and explicit scope instruction distinguish text reviewed in another
batch from genuinely missing information. Narrative text is not duplicated into
every batch. The additional structure has a per-request 1 MiB ceiling, derived
from the existing durable graph result envelope; it does not impose a daily
application model quota. Existing source/retrieval coverage context survives
unchanged, and missing company proof still cannot establish missing capability.

The format migration applies only to an unstarted phase. Prepared instruction
pins, reserved/unknown/settled receipts and a same-phase saved legacy round retain
their original wire input; formats 1/2/3 and batch formats 3/4/5 are immutable.
Special audit verification has a distinct phase-aware format pin and receives its
typed audit candidate. Existing private graph pins provide the migration record;
no database rewrite, paid-request repin, candidate allowance reset, usage rewrite,
provider permission or billing change is performed. Old results keep their old
assurance level; this change does not retrospectively certify their typed fields.

Validation: two regression cases failed before the typed-context change and pass
afterward. The broad local model suite passed 36 files / 809 tests, followed by
10 additional registry-driven requirements-only/aggregate scenarios; the updated
registry file passes all 33 tests. Backend typecheck and build pass. Coverage
was rechecked after the final bounded-context refinements in six focused files /
180 tests, with backend typecheck and build repeated successfully. Coverage
includes all 13 registered tasks: ten business tasks exercise typed paired
mutations, canonical report validation, scoped quotes, required-only coverage,
aggregate IDs and duplicate/invented-ID rejection; repair and verifier tasks
receive local target/report validation without recursive verification, and the
connection probe tests only its ready/transport boundary. Forty-three frozen
synthetic historical wire hashes match committed baseline d5ddad3. Seven fully
migrated database cases preserve prepared/paid/unknown/saved-round phase identity
and accounting. A long draft proves the bounded typed structure does not repeat
out-of-scope narrative, and its batch manifest covers every original content ID.
The existing real graph audit and batching regressions also pass. No external
model/provider calls were made; complete package checks remain integration work.

Remaining ME-08 / W05-W06 acceptance: independently labeled semantic model
qualification for all task/field/language cases, authority and modality contracts,
source spans and semantic dependency expansion, and explicit assurance for legacy
results. Exact citation metadata remains present in each typed batch; the structural
ceiling is not a provider-specific token-fit guarantee for citation-heavy results.
Existing input/context gates still apply, and capacity qualification remains open.
Local payload visibility and canonical scope gates do not establish that
a model will always judge a typed field correctly. The full ME-08 acceptance
matrix, W05/W06 and T01/T02/T09/T19 therefore remain open.
## November 4 — W07 provider classification and guarded automatic recovery (local)

**Implementation:** F10 classification and the narrow F08 retry/handoff conflict
are implemented locally in two additive CLI-created migrations and the adapter.
This is not closure of every W07 historical recovery variant or the proposal
artifact delivery workstream. Nothing in this change was pushed or deployed.
The November 3 permanent-reconciliation limitation above describes the old
runtime; the new canonical automatic path below retains unknown accounting while
releasing only proven terminal or policy-expired execution.

Provider status, bounded error code and reason now distinguish quota/balance,
credentials, denied permission, unavailable model, invalid request and uncertain
transport. HTTP 403 alone no longer means bad credentials. HTTP 200 terminal
background errors retain their lifecycle marker while recording a separate
quota reason and scope. No raw provider message is added to telemetry. Scope is
stored on the attempt and drives both in-round and persisted cooldowns. Proven
model scope leaves a healthy sibling eligible; connection/project/account and
unknown scopes are conservatively shared. Frozen route identities survive
later model edits. Successful GET retrieval and later invalid requests cannot
clear a generation quota window; a successful generation can. Explicit
Retry-After and the existing bounded backoff remain effective. No billing,
credential, free-only setting, or provider limit is changed.

The private automatic recovery predicate replaces only the reviewed permanent
holds in per-job retry, writer-validation handoff and canonical reservation.
Reserved calls and active/ambiguous same-target execution remain blocked. A
terminal exception requires an exact linked failed attempt, matching target
identity and terminal finish reason; historical generic request rejection also
requires the exact remote response ID. Otherwise both the 15-minute boundary and
remote deadline must have elapsed. Null or incomplete evidence fails closed.
Every permitted recovery records immutable receipt lineage before transition or
reservation, including the originating job for cross-job input matches. It does
not settle, delete or zero usage, increase correction allowance, repin old
requests, or waive current source/provenance/lease/authorization checks.

ME-11 local recovery coverage is explicit:

| Execution state | Local assertion and evidence |
| --- | --- |
| Valid automatic candidate with null usage | Existing `roundRobin` canonical completion remains accepted with null usage and no token-count endpoint. |
| Accepted active remote request | Existing continuation tests keep the remote identity and GET; new handoff/retry/reservation cases reject fresh recovery. |
| Ambiguous before boundary or later remote deadline | Immediately-before boundary and unexpired deadline cases refuse recovery without changing receipt, candidate or budget. |
| Ambiguous at/after boundary and deadline | Exact at/after tests allow canonical retry/handoff/reservation, with fresh call identity and unchanged unknown receipt. |
| Proven terminal unknown plus retained alternate candidate | Handoff and actual adapter failover tests preserve candidate/provenance and unknown ledger; tag-only, null-code and mismatched response fail closed. |
| Unrelated old unknown receipt | Existing phase isolation permits independent authorized work; cross-job same-input recovery records the actual prior job/receipt. |
| Exhausted correction allowance | Handoff/retry never replenishes writer budget; candidate-budget RPC still refuses an extra correction. Artifact assembly is a separate workstream. |
| Manual route | Manual terminal-unknown retry/handoff remains refused; legacy manual reservation policy is unchanged. |

**Tests:** focused policy/provider suites passed 252 tests before the full legacy
outage compatibility pass. Real PostgreSQL 17.6 multi-session checks passed three
races: same retry idempotency key, different keys against the same revision, and
active remote refusal. The harness observed both contenders waiting on the real
workspace lock before release. Allowed recovery had one job transition, one
recovery audit and one action audit; stale revision lost; active remote produced
none. Original unknown receipt and an exhausted writer allowance of three were
identical afterward. The reusable test is
`scripts/testing/provider_recovery_races.py`, using the shared
`scripts/testing/postgres_races.py` harness. Its receipt records image and all
migration hashes. Handoff replay/guard coverage is local fully migrated PGlite;
this change does not claim a separate real-PostgreSQL handoff race or live model
acceptance. Final package gate counts are recorded below after completion.

**Deployment / hosted acceptance:** not deployed; no production/model/billing
calls. Both account and unknown scope currently cool all same-provider targets
in the workspace because the catalog has no trustworthy provider-account ID.
This can conservatively delay genuinely independent accounts; narrowing it
requires explicit account identity, not an inferred connection boundary.
Historical rows are not rewritten, and production replay/selected recovery,
full historical successor coverage, hosted artifacts and model qualification
remain separate acceptance work.

Final local package gates for this W07 change: backend **1,904/1,904 tests**
across 111 files, frontend **269/269 tests** across 40 files, and both packages'
`typecheck` and `build` passed. The final historical quota regression covers
code-only terminal attempts with null reason/scope; read-time classification
preserves those old rows. Final real PostgreSQL race rerun passed **3/3** against
the final migration hashes. Provider transport is mocked in these suites; the
PostgreSQL container has no network or published ports. Frontend checks are
jsdom/build evidence, not browser visual or hosted artifact acceptance.

## November 4 — W05 source identity, authority and obligation semantics v1

Implemented `sourceEvidence.ts` and CLI migration
`20261104134540_source_evidence_authority.sql`. New proposal requests pin source
contract 1 and repair contract 1; an existing snapshot without those pins keeps
its original schema and input identity. Original Unicode code-point ranges,
exact quotations, entity/hash/block/extraction identities and current authority
records are resolved before use. The application materializes requirement text
from original passages and keeps interpretation separate. Distinct interpreted
obligations sharing a passage retain distinct identities. Source normalization
has a reversible mapping; normalization never replaces the original citation.

Owner/Editor authority and obligation review commands append versioned records
with workspace locking, current membership, expected revision, idempotency and
audit. Source kind, filename, chronology and numeric precedence never confer
buyer authority. A clause replacement requires an explicitly confirmed addendum
relation to the exact older source hash plus an explicit replaced review ID;
other clauses and original sources remain available. Missing company evidence
does not remove a buyer obligation. Unknown modality or negation cannot be confirmed. Obligations require a known
actor; confirmed informational/nonbuyer material can explicitly have no actor. The canonical inventory and final-assurance checker reject stale,
revoked, superseded or unresolved evidence. Source reviews use the OCR publication
resolver when installed; an old immutable parent stays historical, not current.

The service-side requirement insertion guard independently checks original
text, references, source meaning and authority, so bypassing a model parser does
not persist an unbound v1 requirement. Reviewer reasons remain in append-only
history and are replaced by a fixed label in model context. Review history joins
backup manifests and the existing preview-bound Owner purge. RLS and function
privileges handle both Supabase and managed DigitalOcean role families.

Verification: source tests initially exposed eleven failures, including hidden
semantic mutations and overlong span IDs; corrected tests cover exact Unicode
ranges, hash/version/offset changes, negative and conditional meaning, exceptions,
consequences, actor, quantity/currency/date mutations, independent sibling
findings, forged confirmation, unresolved meaning, addendum replacement,
source-bound persistence, legacy pin preservation, revocation and extraction
successor currentness. Materialized candidates over 768 KiB fail explicitly
without trimming original passages; W06 maps this condition into the existing
bounded split path. Exact source metadata does not certify universal semantics.
Meaning/authority pending review remains explicit and cannot pass the W08 final
assurance gate. Deterministic tests do not constitute live model qualification.

Local integrated validation includes W06 model/graph hooks from `65fb166`; these
hooks are a release dependency, not duplicated in the W05 commit. The source and
runtime suites pass, including all 55 generation/flexible-input cases; historical
recovery fixtures explicitly freeze the pre-v1 contract before any paid work.
The final full package and real PostgreSQL counts are recorded below. Frontend
`typecheck`, all 299 tests and `build` passed. PostgreSQL races observe both
contenders waiting on the workspace lock: same-key replay appends once,
different keys against one revision admit one, and a source edit before release
rejects both stale reviews. Synthetic database only; no provider, production or
billing call, deployment or hosted acceptance was performed.

Final W05 local integrated package gates: backend **2,176/2,176** in 131 files
with `npm test -- --testTimeout=15000`, backend `typecheck`/`build`, generated
OpenAPI, and frontend **299/299** with `typecheck`/`build`. The default five-second
test allowance had one migration-fixture startup timeout; its isolated rerun
passed 6/6, and the complete suite passed with the explicit 15-second test
allowance. This changes no application deadline. Real PostgreSQL races passed
**3/3** against the final source guard migration; subsequent applicability-only
projection changes have focused coverage. Hosted/deployed/live-model acceptance
remains separate.
## November 4 — W06 phase 2 scoped patch executor and source-contract hooks

Implementation: local source only, not deployed or hosted-accepted. New workflows
with `repair_contract_version=1` use a phase-pinned patch response instead of a
complete replacement candidate. The server binds the base candidate, scope,
unit and previous-value hashes; supplies exact typed path schemas; and composes
authorized replacements, additions or appends. Existing array units cannot be
deleted or reordered. The one removal operation is confined to an unsupported
company-claim declaration and requires its associated narrative correction and
an appended question for the missing proof. Optional missing fields and missing
planning units are added without replacing their existing siblings.

Application-owned task-field dependency groups expose linked requirement text,
modality, source semantics and commercial assumptions with recorded reasons.
Ambiguous/unlocated findings do not authorize a document-wide rewrite. Model
requests cannot widen the supplied scope or edit review approval identities.
Known effort/allocation changes recalculate the minimum dependent duration using
decimal arithmetic, retaining longer explicit durations and unrelated tasks.
The complete composed target still passes canonical domain validation and an
independent grounding pass. Applied-path receipts retain the original candidate,
canonical new hash, dependency reasons, derived arithmetic and unresolved/overflow
counts; receipt hashes remain stable across PostgreSQL JSONB key ordering.

Prepared semantic/quote-scope pins, accepted or settled/unknown phases and saved
legacy rounds retain their existing request/schema identities. Numeric durable
schema versions remain compatible with SQL: legacy 1, source contract 2, scoped
patch 3. No candidate allowance, retry budget, unknown usage, provider permission,
billing/free-only setting or automatic daily quota policy changes. Both source
contract hooks and patch application run before invalid-candidate retention;
source authority/review fields are materialized from the immutable application
contract, and source diagnostics join reference diagnostics with explicit overflow.

Validation: both lockfiles installed. Full local backend suite passed 132 files /
2,173 tests; frontend passed 46 files / 299 tests; both typechecks and builds pass.
This includes the actual migrated graph's legacy/new patch positive, crash and
out-of-scope rejection cases, immutable accounting/allowances, source tuple
correction, 33 independent source defects producing 32 diagnostics plus one
omitted, forged approval materialization, required append/no deletion, dependency
arithmetic, stale base/unit/path rejection, and the 43 historical wire hashes.
The sourceEvidence module is the coordinated W05 agent dependency and is not
duplicated in this component commit. The full suite used that local dependency;
integration must include its final reviewed revision and repeat combined checks.

Remaining phase-2 work is tracked separately: wider same-requirement semantic
diagnostic enumeration, additional typed-field/provider-context qualification,
fresh connected frozen-corpus evaluation and independent semantic holdout/domain
review. These local controls do not establish universal semantic correctness or
provider capacity for every possible document. No external model calls occurred.
### 2026-11-04 — W10 optional structured authoring and immutable adoption

**Implemented locally:** source-cited authoring sessions, immutable response revisions,
explicit responsibility claims, current source/authority checks, human review scoped to
actual response excerpts, canonical consistency checks, and separate renderer-2 saved
files. A current Owner/Editor may adopt reviewed content into a new ordinary proposal
version with immutable requirement mappings; normal compliance, commercial, consistency
and final-approval gates still apply. Later human edits invalidate prior approval and
require a new adoption. Source successors retain prior text and provenance, clear stale
requirement bindings, and require explicit review. Background accepted units remain
saved without replacing a selected authored delivery. Version-1 payload semantics and
renderer output remain pinned. New renderer-2 jobs require executor 4; old claims remain
restricted. New schema privileges support both installed role families.

**Policy update:** manual authoring is an optional authorized workflow, not a mandatory
staff fallback and not success for an automatic request. The user's later D06 decision
requires an immediate clear error when all AI agents are unavailable and a request-wide
600-second automatic issuance limit. Deadline/admission and automatic complete-file
projection are separate implementation work; this entry does not claim their completion.

**Evidence:** migrated SQL/API/real Word pipeline verifies actual supplied synthetic
responses without model calls, no automatic approval, renderer-2 download, explicit
ordinary-version adoption, replay, revision conflicts, current membership, source-change
successor retention and direct-RPC ACL denial. Focused snapshots/pipeline: 33 tests passed;
runtime wake/pipeline: 109 passed; authoring/delivery UI: 12 passed. Five real PostgreSQL
multi-session races passed using the synthetic, network-isolated PostgreSQL 17.6 harness:
`python3 backend/scripts/testing/authoring_races.py --container <synthetic-container> --output <private-receipt>`.
Both contenders were observed waiting on the workspace lock. Receipts contain migration
hashes, identities and counts, not customer content or secrets. Full package validation is
being reconciled against the integrated phase-2 source/consistency changes; these focused
results are not a claim that the complete integration suite passed.

**Deployment / hosted acceptance:** not deployed by this change; no production/model/email
calls. Browser visual acceptance, hosted artifact storage/restore and the separate
600-second automatic generated-review-draft route remain unclaimed here.

### 2026-11-04 — Original-bound PDF page correction interface

Implemented a shared PDF page review interface for opportunity and Company Knowledge
files. The browser verifies the private original bytes against their SHA-256 before
allowing review, displays the original beside editable full-page text, requires
explicit comparison and separate blank-page confirmation, and submits immutable
source/revision/page hashes to the W02 correction API. Edits clear their review flag.
Lost replies reuse the same idempotency key; conflicts retain unsaved text; document
changes abort stale work and revoke local preview URLs. Reviewers remain read-only.
Automatic OCR failure is not described as an invalid RFP.

Validation: eight focused jsdom tests passed, covering Arabic correction, blank pages,
batched edits, source mismatch, bounded previews, stale selections, read-only access,
CAS conflicts and lost-response replay; frontend typecheck passed. These are not
real-browser or hosted authorization evidence. W02 backend integration and final
package/browser acceptance remain separate pending checks. No production data or
model calls were made by this interface change.

### 2026-11-04 — Extended production inventory receipt

GitHub Actions run [41849412810](https://github.com/salahassi/tenders/actions/runs/41849412810)
at source `59c6b309470cacf4dd605325e9a76cb132b88449` succeeded with original cluster
CA verification, ten ready workloads and verified temporary-client cleanup. The
read-only receipt is `evidence/digitalocean-inventory-20261104-41849412810.json`.
It captures actual native browser/OCR schedules, immutable images, resource limits,
queue counts and capacity without business/schema mutation, model calls or bootstrap.
The six production release receipts and routine catalog hash match the first inventory.
New delivery/issuance schema is still absent: this is baseline evidence, not deployment
or proof of the new 600-second SLO. Earlier run 41845129587 failed because the observer
incorrectly assumed renderer schedule defaults; TLS access passed. The observer now
records bounded actual settings and explicit/default fields instead.

### 2026-11-04 — Semantic harness declaration integration

Added TypeScript declarations for the frozen bilingual semantic qualification helper
and its suite names/limits, and narrowed fixture-language/nullability in the existing
semantic harness tests. Backend typecheck passes against integrated W05/W06/W08/W10
foundations. No prompt, corpus, gold labels, provider calls or live outcomes changed.
The real English/Arabic campaign remains unqualified; independent failure adjudication
and the remaining implementation checks are recorded separately.

W05 rolling-worker follow-up: source contract activation now installs its
executor floor in the same migration before admitting new snapshots. New source
or repair contract jobs retain `minimum_worker_executor: 4` independently of
older `model_executor` values. Both eligibility predicates in the fair queue
honor the greater value. A test stopped at the exact `134540` migration boundary
proves executors 1/2/3 cannot select the v1 job while executor 4 can, and a later
`model_executor: 2` update cannot lower the floor. Source/module tests pass 27/27.
This rollout guard intentionally changes current-worker fixtures; combined
issuance-deadline integration must use executor 4 for new workflows. The earlier
full-suite totals above preceded this rolling-worker refinement.

### 2026-11-04 — Request-wide issuance status in the interface

The authenticated issuance-status route delegates to the membership-checked RPC;
its response drives the proposal preparation panel separately from generation-stage
completion. Finished writing cannot show complete-package success for a new request.
Unavailable agents and the 600-second terminal state have explicit messages, failed
issuance alerts use the exact current request identity, and stale request responses
cannot claim success. Progress polls remain serialized, including slow workspace
refreshes, with a five-second display refresh; the server deadline is authoritative.

Validation: 18 API boundary tests and 24 generation-panel tests pass. The integrated
frontend currently passes 49 files / 317 tests, typecheck and production build; backend
typecheck passes. The new RPC depends on the coordinated deadline migration, which
is not deployed yet. Real hosted timing/package issuance remains a separate gate.

### 2026-11-04 — Actual bilingual semantic development results

Both bounded live campaigns completed against source `ea420a00082f23b7b540f099dd76515378142652`:
English [41844431244](https://github.com/salahassi/tenders/actions/runs/41844431244)
and Arabic [41844440530](https://github.com/salahassi/tenders/actions/runs/41844440530).
Sanitized per-target/case outcomes and private-receipt hashes are retained in
`evidence/semantic-development-v1-20261104.json`; raw private diagnostic bundles
are excluded from the repository. Each campaign attempted 64 cases, one attempt
per case, with zero production business records created. Frozen v1 labels and
original scores are retained unchanged pending independent adjudication.

OpenAI gpt-6-luna and gpt-6.1-sol rejected every request for unavailable credits;
QwenCloud qwen3.8-max rejected every request for exhausted free quota. DeepSeek
v4-pro through QwenCloud passed 11/16 English cases and 9/16 Arabic cases under
v1 scoring. Its final five Arabic cases also returned provider 403 free-quota
exhaustion, so those cases are unscored availability failures, not demonstrated
semantic misses. All four tested targets were unavailable by the end. No billing
or free-only account setting was changed. English measured 77,330 input / 8,241
output tokens with 48 unknown-usage cases; Arabic measured 53,961 / 6,589 with
53 unknown-usage cases. Unknown accounting is retained, not silently set to zero.

Neither campaign qualifies a provider. Validity/semantic failures and a suspected
oracle containment false negative require independent offline adjudication before
any versioned evaluation correction; private holdout D07 and live complete-proposal
acceptance remain open. Further live success requires an available provider.
## November 4 — current content binding for Owner applicability decisions (W08)

Migration `20261104144002_requirement_applicability_binding.sql` extends the
existing Owner-only `compliance.save` / `not_applicable_approved` action. New
pinned workflows require `expected_applicability_binding` from the Owner's current
view. The existing workspace-locked command checks it against the exact current
source-reviewed requirement, version content/package/evidence and every actual
section row; a fresh hash is never silently attached to a stale approval. Version
revision-only changes do not invalidate otherwise identical content. Source
meaning or authority still pending cannot be waived through this route, and the
existing mandatory-eligibility prohibition remains intact.

The current consistency context exposes server-derived requirement bindings,
review reasons and approved exclusions only while the confirming Owner and
allowlist remain active and all hashes/current sources still match. Legacy and
restored unconfirmed N/A records acquire no new authority. Restore clears the
new binding together with existing confirmer fields. There is no parallel role
or approval mechanism. W08 owns the corresponding UI and coverage classification.

Focused SQL tests pass **8/8**, plus **5/5** existing commercial regressions;
backend typecheck/build and generated OpenAPI pass. Four real PostgreSQL races
observed both sessions waiting on the workspace lock: same-key replay appends
one decision/audit, different keys with one revision admit one, a late section
edit rejects both old-view requests, and revoking the Owner while waiting rejects
both requests. Source workflow executor-4 and W08 context migrations are explicit
integration dependencies. No live model, production, deployment or hosted
acceptance call was made by this change.

### 2026-11-04 D06: request-wide issuance deadline and terminal availability

Implemented locally; deployment and hosted acceptance remain pending. New explicit
proposal authorizations receive an immutable request row with acceptance time,
600-second deadline and terminal outcome. The request ID lives outside frozen
model input and follows generation children, repair/resume work and local rendering.
An idempotent replay retains the original deadline. New reservations, successful
generation commits and artifact completion are deadline-gated. Canonical queue
claims and maintenance persist expiry; the member-scoped status RPC also reports
the effective deadline outcome immediately, with database `server_now`. Unknown
or reserved provider usage is preserved exactly and remains separately reconcilable.
All initially unavailable targets, or an exhausted round of known rejections,
return `AI_AGENTS_UNAVAILABLE` for a new issuance without waiting for another round.
An accepted remote request may still perform GET-only reconciliation during its
original remaining deadline. POST and GET transport timers share that absolute
request deadline. Historical unpinned routes keep their prior behavior.

New contracts require `minimum_worker_executor=4`, independently of immutable
`model_executor=2` routing pins. The canonical claim predicate excludes older
workers. The earlier W05 migration installs the first contract activation guard;
this migration accepts that already-installed predicate. A single-job retry binds
only its authorized target; unrelated historical running/waiting siblings and
paid prompts remain unchanged. Explicit local projection/render retry starts a
new authorization against the same accepted canonical version without another
model call or changes to its candidate budgets. A completed plan cannot silently
restart with no queued work. Automatic issuance requires the full immutable
renderer-3 generated review-draft package, canonical version/hash pins, machine
validation and all verified volumes. Partial templates never count as issuance;
issued draft status does not grant final approval or human semantic confirmation.

Validation so far: both dependency lockfiles had been installed; backend typecheck
and build pass; frontend full 46 files / 299 tests, typecheck and build pass. Focused
actual-SQL deadline/retry/managed-role checks and historical plan-state tests pass
52 cases; provider deadline/availability tests cover missing/disabled/cooling
routes, all-target 403 quota rejection, absolute POST/GET timeout and accepted
GET-only continuation. Full routing/catalog regression group passed 152 cases.
The previous broad run exposed a renamed PL/pgSQL parameter-qualification defect;
that was corrected and routing/catalog rerun green. Historical model fixtures now
explicitly seed legacy admissions only during synthetic setup, re-enable the new
admission guard before execution, and use current worker capability for model-only
claims. Dedicated renderer tests retain responsibility for real local job ordering.
The combined full backend rerun is pending at this commit; earlier runs are not
claimed green. The coordinated renderer-3 agent must complete positive full-package
issuance and explicit projection/render retry tests against this migration before
release. Managed-only role migration, exact SQL 599.999/600/600.001 boundaries,
queue dwell, unknown receipt retention and old-worker exclusion are already tested.

Remaining gates: combined source/consistency/renderer integration, full backend
regression completion, actual connected stopwatch/queue-stall acceptance and fresh
semantic qualification under the approved campaign. No provider calls, payment
changes, daily application caps, or billing/free-only policy changes were made by
this component. Public Supabase database-function guidance was consulted for the
migration; local PGlite checks are not hosted PostgreSQL/cron acceptance.

## November 4 — W02 durable uploaded OCR and reviewed extraction successors

**Implementation:** local code/migration implemented; integration and hosted
acceptance remain separate. Migration `20261104133930_durable_uploaded_document_ocr.sql`
adds service-only, workspace-bound OCR requests/pages, leases, fixed retry
receipts and private original-copy publication. Accepted mixed PDFs queue only
unresolved pages. Existing readable text, page order, source hashes, historical
blocks and paid request pins remain retained. A verified physical copy is
reserved against combined storage capacity before upload; only its verified
hash/size and current actor/source permit atomic successor publication. Ordinary
upload completion cannot publish an OCR reservation. Restart, duplicate replies,
copy-response loss, capacity failure and expired reservations have explicit
recovery paths. Pending-copy expiry cannot archive the readable parent.

The existing native OCR CronJob now drains uploaded and public queues fairly
through `scripts/backend/native-ocr-worker.ts`. The run remains bounded to nine
minutes and ten rounds; each family receives a turn. A whole attempt must fit
inside the remaining budget, including native execution, gateway timeouts and
possible identity renewal. Uploaded processing uses the existing 10 MiB original
and 200-page admission limits, one selected page, a 2,000-pixel raster, one native
thread and a 90-second native deadline. It never labels a scan, timeout, parser
failure or resource limit as a business-invalid RFP. The single CronJob is
retained; no new schedule or vendor was added.

**Recognition and review:** the frozen real offline synthetic Arabic test failed
with confidence **82** and `numeric_uncertainty=false`: an obligation was omitted
and prohibition/deadline words changed. Its exact text/hash is a SQL regression
fixture; the independent native receipt is
`docs/evidence/uploaded-ocr-native-20261104.json` in the integration branch.
The Arabic oracle was not weakened. This Tesseract policy does not qualify
Arabic output as readable evidence solely from confidence; candidates stay
available for visual correction. English recognition and mixed-page extraction
passed the frozen native cases, but all OCR text remains unconfirmed. Known
blank pages also require explicit page review before confirmation.

`GET /v1/documents/{id}/extraction` returns authorized page text, previous page
hashes, review state and the existing 300-second private-original URL, with a
second authorization check before responding. The bounded correction command
accepts complete reviewed page text, original/extraction/page hashes, expected
revision and explicit blank confirmation. It persists a new human extraction
successor; it never rewrites old text under an old hash. Supplied actors cannot
replace the authenticated actor. A new explicit correction may supersede
unfinished work while preserving its receipts and ambiguous-byte reservations.
Company Knowledge verification cannot bypass unreviewed OCR. Restored receipts
retain historical provenance; restored human review requires fresh current-user
review. Legacy image-only PDFs and legacy text with intact page anchors can
recover coverage without rewriting the old record. Nonempty historical text
without trustworthy page anchors requires a new correctly extracted upload;
its page positions are not guessed.

**Source selection and storage:** fresh snapshots select only current published
extractions before the existing context-size guard. Historical proposal
resumptions select their pinned RFP sources before that guard. With the W05
source contract, a superseded source refuses continuation as stale while the
saved paid context remains unchanged. The independent source-review context
selects the child and does not inherit buyer authority. The optional
`document_ocr_published(child, actor)` hook lets authored-review sessions record
source change without replacing accepted prose. One successor stores one
additional complete original: physical storage amplification is measured as
100 → 200 bytes in synthetic reservation tests and still counts historical
originals/cleanup bytes. Group reviewed pages into one correction to avoid one
physical copy per page; no logical deduplication is represented as free storage.

**Local verification:** dedicated SQL/gateway/API suites cover mixed-page
retention, exact Arabic failure classification, full paragraph/blank review,
revision/hash mismatch, current membership revocation after stored-byte read,
late leases, idempotency, immutable copy reuse, family archive/history guards,
capacity/expiry, legacy image-only recovery and native/ human restore. A
900,000-character source with eleven retained extraction versions proves early
source selection stays bounded without replacing prior paid pins. Combined OCR
plus W05 migration testing passed 26 cases, including current-source exclusion
and stale paid-contract refusal. Both package typechecks/builds passed; frontend
300 tests passed (includes the new real client transport/cancellation contract).
The core backend suite passed **2,185/2,185** tests across 131 files. The final
review-metadata/disk-capacity delta passed **37/37** focused tests; its combined
full-suite repeat remains separate integration evidence. Root-owned
visual page-review UI and its tests are integrated separately in commit
`6de550e`; this entry does not claim browser visual acceptance for those controls.

**Native image / deployment:** local image
`tenderdesk-uploaded-ocr:v2-final-r2` is
`sha256:42bda8349d80507c1b7d5fd299d1c9be59ece8f559256bfc8b8bf90f6d8b40af`.
Offline imports under runtime UID 1000 passed with 768 MiB, one CPU and no
network. COPY ownership fixes the measured unreadable-package failure. The
final image uses the same recognition algorithm as the failed Arabic oracle;
automatic Arabic semantic qualification remains **failed**. No image push,
production migration, deployment, customer data, provider call or hosted
upload-to-file result is claimed. OCR is independent source improvement and
cannot promise 200 scans or human review within an issuance deadline; the
issuance contract must retain current coverage/gaps and report a truthful
terminal result rather than silently treat unresolved pages as empty input.

Final native capacity handling maps temporary-disk `ENOSPC`/`EDQUOT` to
`DOCUMENT_OCR_CAPACITY`, with source hash rejection before temporary allocation.
The deployment already mounts native `/tmp` as a bounded 1 GiB writable
`emptyDir`; local native reruns use an explicit tmpfs to avoid the measured
shared build-host overlay exhaustion. This is a resource failure, not an
Arabic recognition result. The rebuilt r2 image identity is recorded above.

### 2026-11-04 — Actual browser original-page rendering correction

Real Chromium visual inspection found that the browser's embedded PDF plugin could
show a blank dark region even though the original bytes were verified. Replaced
that dependency with the existing PDF.js renderer, bounded page dimensions/time,
page zoom and keyboard-scroll access. Review confirmation is disabled until the
selected original page has actually rendered. Failed/stalled rendering and stale
page completions cannot authorize a confirmation; changing the document destroys
its worker and revokes preview URLs. Oversized images are not silently omitted by
a maxImageSize cutoff. The signed original is still hash-verified before rendering.

Twelve focused component tests pass, including pending render, decode failure,
late prior-page completion and a stalled 30-second render. Frontend typecheck
passes. The repeatable isolated browser harness is
`scripts/testing/documentExtractionReview.browser.mjs`; it runs the real component
and an actual raster PDF without product routes or production data. Four Chromium
checks passed in Arabic/English at 390/1440px: original pixels painted, no horizontal
document overflow or browser errors, explicit confirmation and save. Arabic mobile
and English desktop screenshots were visually inspected. Receipt hashes are in
`evidence/document-extraction-review-browser-20261104.json`. This is browser fixture
acceptance, not a live user's upload or hosted authenticated acceptance.

The issuance status read route is also documented in the generated OpenAPI contract,
including current membership, database time, effective timeout, and complete draft
package semantics. Regenerated the contract from the canonical command schemas;
no runtime or deployment behavior changed by this documentation follow-up.
D06 follow-up: required final renderer-3 failure closes the issuance; an optional
initial/partial renderer-1 preview failure retains independent model progress.
A verified issued package cancels leftover optional work without deleting ready
bytes. Closed-request late failure recording is idempotent. Explicit local retry
now checks the exact accepted active version and hash, and avoids a PL/pgSQL
parameter/ON CONFLICT ambiguity found by the renderer agent's real SQL retry.
Historical migration fixtures also handle the genuine pre-deadline schema where
there is no admission trigger yet. Verifier-child tests preserve the entire
immutable pin object and separately assert the required runtime floor.

Follow-up validation: 110 delivery/routing/managed/deadline cases passed, followed
by 71 deadline/managed-role and historical prompt/recheck cases. The broad backend
run before these final fixture corrections passed 2,182 of 2,197; its 15 failures
were all the absent-trigger setup at the deliberate historical migration boundary,
now corrected and rerun. Root's combined run additionally exposed two runtime-floor
fixture assertions; the follow-up preserves exact verifier pin assertions and uses
the current worker for that sibling. A final combined full run and renderer-3
issuance/retry acceptance remain required; no full-green or deployment claim is
made from these focused runs.

## November 4 — source-review assurance after backup restore (W05)

Migration `20261104150228_restored_source_review_assurance.sql` restores original
source authority and obligation review history without reactivating imported
confirmations. A narrow requirement-import exception requires the actual current
Owner, an unexpired committing restore session created by that Owner, and the
canonical restored plan markers. A session setting alone grants no exception.
Restored requirement tuples and citations remain intact, with live review and
authority fields reset to pending/unknown. New current-Owner revocation revisions
retain the imported historical rows unchanged. The transaction restores its prior
scope setting; an idempotent restore replay does not revoke later explicit reviews.

The real public backup/stage/file-completion/commit roundtrip passes in the local
migrated database, including incomplete-restore rollback, forged scope denial,
private-helper ACL denial, original-history preservation, restored assurance
reset, ordinary-write guard retention and replay after reauthorization. Combined
source restore, existing recovery and applicability tests pass **10/10**; backend
typecheck/build pass. Independent SQL review found no blocking issue. This is
local validation, not deployed or hosted restore acceptance; the isolated cloud
restore acceptance will separately exercise the actual managed catalog and files.

Independent browser review follow-up: the signed-original fetch and byte stream now
share a 30-second abort deadline, scoped separately from the editor so a stall shows
an explicit retryable error. Selection/unmount still cancels immediately and leaves
confirmation disabled. Thirteen component tests and frontend typecheck pass,
including an actual pending fetch aborted at the deadline. No provider or hosted
request ran for this check.

The final integrated native OCR image `42bda8349d80507c1b7d5fd299d1c9be59ece8f559256bfc8b8bf90f6d8b40af`
was rerun offline with the unchanged frozen corpus, 768MiB/one CPU and a bounded
256MiB temporary filesystem. Three cases passed; the Arabic exact-obligation case
still failed with the same omitted first obligation. The evidence retains that
failure. An earlier local container temporary-filesystem capacity error was
separated from recognition quality; the deployed CronJob already has a bounded
writable temporary volume. These are native local results, not hosted OCR acceptance.

### 2026-11-04 — Independent closure audit and acceptance-policy reconciliation

An independent point-in-time audit of `a9ae357` identified three remaining code
paths: early/partial hosted acceptance tooling, ordinary browser-dependent export,
and all-domain diagnostic enumeration. Those are assigned for implementation;
renderer-3 integration and the separate quality/capacity/recovery/deployment gates
remain explicit. The immutable audit snapshot is
`evidence/reliability-closure-audit-20261104.json`; it is not final release acceptance.

The main workstream ledger now reflects implemented source/repair/consistency/OCR
and deadline controls without claiming deployment. The acceptance header no longer
incorrectly says all cases are unimplemented. AR-02 and execution step 6 now match
the owner's already-resolved D06: immediate no-agent error, request-wide600s guard,
no mandatory human fallback and no template-as-full-success. This reconciles
superseded wording; it does not change the owner's policy or erase failed evidence.
### 2026-11-04 — Automatic generated review draft and durable complete-package issuance

**Implemented locally:** a completed, explicitly admitted generation request atomically
queues `prepare_generated_delivery`; a separately leased local worker reconstructs the
actual accepted assembly and checks its chosen whole-candidate verifier receipts without
another model call. Immutable payload/renderer 3 preserves every accepted section and
required volume, original version/input hashes and receipt identities. It is a
`generated_review_draft`, `substantive_complete=false`, and `source_review_required`;
it never invents human assurance or final approval. Historical renderer 1 and manual
renderer 2 retain their own contracts. New projection/render jobs require executor 4.
Known machine defects, source restatement, generic responses, missing verifier receipts
and render-policy omissions fail explicitly. Missing company/commercial facts remain
specific yellow review inputs when a substantive verified response exists.

**Currentness and lifecycle:** both projection publication and in-progress render
boundaries recheck current source documents/OCR leaves and confirmed source-obligation
reviews. Changed sources or revoked actors cannot publish after waiting for the workspace
lock. Optional authored content remains selected when background generation completes.
Unconfirmed OCR/page coverage cannot become a substantively complete human-reviewed
authoring result; the server-derived qualification joins its context hash and adoption
gates. Historical immutable files remain governed by their original read authorization.
Only a complete, verified required-volume package can finish the original 600-second
issuance request. Explicit authorized local retry creates a new deadline and reuses the
accepted version; historical unknown usage remains unchanged. Unadmitted/historical
plans are not silently opted into the new issuance protocol.

**Evidence:** `generatedDeliveryPipeline.integration.test.ts` has 13 passing migrated
SQL/worker/actual DOCX/API cases, including genuine technical + financial volumes,
no first-volume success/download, deadline expiry before upload, exact-version retry,
same-key replay, unchanged unknown usage, revoked membership, changed source meaning,
actual corrected extraction successor, exclusive-lease recovery and Arabic/English
paragraph/table yellow OOXML checks. The focused projection, runtime, renderer and old delivery regression run
passed 52 tests across five files. Backend typecheck/build and frontend typecheck/build passed; the full
frontend suite passed 302 tests. These are local synthetic receipts, not hosted model
qualification or real-browser visual acceptance.

Three real PostgreSQL multi-session publication races passed with both contenders
observed waiting on the workspace lock: duplicate publication has one snapshot/audit/job;
source edit and actor revocation reject publication. Reproduce with
`python3 backend/scripts/testing/generated_delivery_races.py --container <synthetic-container> --output <private-receipt>`.
The portable `generated_delivery_fixture.py` contains synthetic structural receipt data;
it does not establish live model semantic quality. The private receipt records the exact
migration hashes and PostgreSQL image digest. No customer data, secrets, paid model calls,
production writes, or email were used.

**Integration / deployment limits:** complete backend regression and final release
capability checks belong to the composed phase-2 tree. Hosted storage/restore, native
Word visual QA and live request timing are separate acceptance evidence. Ordinary
approved-version export still requires the subsequent durable `render_export` package
path; this generated-review-draft change does not close that separate browser-dependent
workflow or claim a production deployment.
## November 4 — separately versioned semantic scorer correction

Added explicit `semantic_v2_en` and `semantic_v2_ar` evaluation suites with an
independently frozen version 2 corpus. Version 1 corpus/scorer bytes and original
live results remain unchanged. Version 2 accepts correctly bound full-summary
quotations, requires quantity-plus-object gold spans and the affected source
quantity, and recognizes the observed Arabic condition-removal forms. It does
not relax canonical verifier coverage, source references or candidate hashes.

Local focused tests: both semantic suites **49/49**, including 44 version 2 cases
and the five original version 1 tests; Python activation/report gates **21/21**.
The 44 include 32 controls, two sanitized saved reports, six specified negatives,
source-object binding, immutable version pins and both unavailable-provider suites.
All transports in local tests are controlled fixtures; no live calls or deployment
occurred. Full combined package checks follow the separate metadata-prompt fix.
The sanitized adjudication document retains original unqualified counts and raw
report hashes; this scorer correction does not qualify any model or restore quota.

W02 independent review follow-up: a second page correction before publication
now carries forward unoverridden saved human pages only when original,
extraction and previous page hashes match exactly. Reload exposes saved human
text before an OCR suggestion. Page reviewer IDs/times remain unchanged.
Mixed or revoked reviewer authority cannot become the new actor's whole-file
confirmation: the content is retained as requiring review until one current
actor explicitly reviews every page. Null service/stored leases and missing
admitted hashes/page counts/sizes fail closed. Current-source traversal retains
cycle detection and supports more than 200 extraction versions; the PDF page
limit is not a limit on correction history. The independent rereview found no
remaining material blocker in this slice. A fully reviewed blank successor stays
current as `needs_processing`, with no readable blocks; confirming the extraction
is blank does not assert that it contains sufficient proposal information.
The follow-up passed **44/44** focused cases (34 SQL, seven transport and three
native resource cases), plus both package typechecks. Hosted acceptance remains
unclaimed; the root integration gate covers the combined final branch.

W02 interface follow-up labels a pending human page correction as saved human text,
retains its original page-hash binding, and explicitly explains when current review
is still required for whole-file confirmation. Pending/retry messages cover both
OCR and publication processing. The combined OCR editor, verified-page renderer
and issuance-panel focused run passes38 tests; frontend typecheck passes. No prior
reviewer is silently replaced by the current user. Hosted acceptance is separate.
## W04 — version 2 early/partial saved-delivery acceptance (2026-11-04)

Implemented a separate, explicitly activated `accept-saved-delivery.yml` and
`delivery-snapshot-acceptance` harness. The old completed-plan export harness and
its selection remain unchanged. The new read-only selection binds exact current
snapshot/revision/hash and current allowlisted Owner/source checks. It reuses
genuine isolated Auth, verifies actual authenticated stored DOCX hashes and
canonical content/highlights, requires the complete volume set and succeeded
job, and rechecks source/member/package currentness after download. Pending and
blocked observations explicitly report no verified deliverable. Template,
partial, human-reviewed substantive draft and generated issued draft are
separate expectations. Issuance requires the exact original 600-second request
receipt; terminal failure cannot be reported as issued. The harness renders no
new file and performs no business mutation/provider call. Sensitive selections,
reports and files retain encrypted private transport and logout/cleanup guards.

Local validation: **39 tests passed across 4 backend files**, including **19
new** transport/canonical DOCX and fully migrated selection cases plus the
preserved completed-proposal acceptance tests; **8 Python guard tests passed**.
Backend typecheck/build passed. The modified behavior is tooling only; no
frontend source changed in this commit. Existing package lockfiles/dependencies
are unchanged. See `DELIVERY_SNAPSHOT_ACCEPTANCE.md` for exact versioned selection
and report semantics.

Deployment and hosted acceptance: **not deployed or dispatched**. Local test
transport uses synthetic fixtures only, never production records; it does not
prove hosted Auth/Storage, browser tab-close/re-entry, all-page layout, capacity,
latency or production recovery. Version 2/3 classification is covered locally;
the canonical generated v3 pipeline tests are a separate integration evidence
set. Real selected early/partial/generated issuance and authenticated download
runs remain release gates. This closes the missing harness implementation,
not those hosted acceptance gates.
## November 4 — phase-pinned analysis classification instructions

Verifier instruction revision 5 distinguishes the typed
`requirements[*].category` enum from narrative assertions. It retains every
content ID and source ID and asks the verifier not to invent a factual claim
solely for a classification label. The same words in narrative, and all modality,
authority, actor, quantity, date and condition fields, retain ordinary verification.
No validator strips reported defects, repairs IDs or relaxes factual evidence.

Only a genuinely unstarted typed analysis verification phase with frozen
`source_contract_version: 1` selects revision 5. Existing instruction pins,
prepared/settled/unknown usage and the explicitly version 4 recheck route preserve
their previous identity. Candidate content, schemas and batch partitioning remain
unchanged. Both semantic scorer suites still use explicit revision 4; their
results do not qualify this new prompt. This is an instruction improvement, not a
guarantee that a live model will obey it; no fresh provider call was made.

Full local backend checks pass **2,429/2,429** in 152 files; frontend passes
**325/325** in 52 files. Both package typechecks and builds pass. The complete
backend run includes the expanded 83 instruction/metadata/typed-registry/recheck
cases, all historical wire hashes, and real migrated reserved/unknown/settled
source-contract phase preservation. These are local deterministic checks, not
live prompt qualification, deployment or hosted acceptance.

Explicit future prompt-5 campaign: `semantic_v2_metadata_en/ar` now selects the
same frozen version 2 corpus with verifier policy 5 and distinct case/receipt
identities. Plain `semantic_v2_en/ar` remains policy 4. JavaScript, Python and the
workflow choice list all require explicit selection; the live default is still
false. Python rejects mixed baseline/metadata policy receipts. All eight related
evaluation test files pass **86/86**, Python gates **21/21**, and backend types/build
pass after this additive campaign change. The preceding complete package results
remain 2,429 backend / 325 frontend; four new campaign tests are included in the
86 focused total. No metadata campaign was run live, and no model gained a new
qualification or availability claim.

### Generated delivery integration fixture correction (2026-11-04)

The combined source-contract/generation pipeline exposed a fixture mismatch:
`delivery_input` did not include source block hashes or extraction versions, yet
the fixture manually marked those inputs as source contract v1 and attached a
separate span catalog. Exact task reconstruction correctly rejected those
receipts with `SOURCE_SPAN_STALE`. The fixture now obtains the actual migrated
`draft_generation_snapshot` and its own source evidence, and independently
validates each receipt against that exact task evidence before persistence.
No runtime validator, proof eligibility, authority or scope was relaxed.

Local integration evidence: **13/13 generated delivery pipeline cases pass**,
including actual SQL/worker/DOCX/authenticated API-adapter download, the complete
two-volume gate, source/member/current-leaf revocation, stale projection leases,
request deadline during rendering and explicit fresh-deadline retry. These are
isolated migrated database and transport-fixture tests, not hosted Auth/Storage
or provider qualification. Deployment/hosted acceptance remains pending.
D06 real PostgreSQL follow-up (2026-11-04): a multi-session regression reproduced
an artifact receipt admitted after waiting past its deadline on the workspace lock.
The shared issuance guard now locks and re-reads before checking the absolute
clock. Six isolated PostgreSQL 17.6 cases pass: exact 599.999/600/600.001 boundaries,
before-deadline full completion versus expiry, expiry versus late completion,
late final artifact receipt, early terminal failure, and explicit local retry with
one new authorization, worker1/2/3 exclusion and byte-exact unknown usage retention.
All contenders were observed blocked on real database locks; ready historical
artifact records survive expiry unchanged. The portable script uses synthetic
accepted graph records only and does not claim provider/semantic qualification.
Receipt: /workspace/output/proposal-issuance-postgres-races.json, including every
migration hash from the combined source/OCR/renderer schema. No production calls.

An explicitly authorized renderer1 template retry now creates independent local
render work after a failed automatic issuance. It retains the original failed
request/deadline, grants no automatic issuance success, and still passes canonical
role, source, revision and idempotency checks. The workflow agent owns its actual
API-to-DOCX regression; that test is pending integration of this slice. Previously
committed standalone backend validation finished green: 135 files / 2,198 tests,
backend types/build; frontend46 files /299 tests and types/build. Hosted release,
combined final regression and stopwatch acceptance remain separate gates.
T02 reviewed-blank follow-up: a current, fully page-reviewed blank PDF now gets
`INSUFFICIENT_INPUT` with an explicit reviewed-blank description in new v1
snapshots. Unresolved scans and failed pages keep `UNREAD_INPUT`. The private
predicate checks persisted original/page hashes, exact frozen review metadata,
complete all-blank coverage and current reviewer authority; a client confirmation
flag or filename cannot establish the disposition. Existing immutable payloads
are not rewritten. The new assertion failed before the fix; **44/44** OCR SQL,
transport and resource tests pass afterward, including fabricated metadata/hash
and revoked-review negatives. Separate root tests cover the real UI and
API → SQL lease → DOCX renderer → authorized download journey; hosted acceptance
remains separate.

### T02 connected empty/invalid input journey (2026-11-04)

The actual OpportunityDetail upload/prepare UI keeps “Save available draft”
available when no documents were persisted and AI generation is disabled.
Real empty-file and invalid-PDF-signature extraction errors reach the typed
`delivery.snapshot.prepare` disposition without creating a document. The saved
package UI shows insufficient information, yellow-input guidance and download.
Three focused UI tests pass; their API transport/download is mocked, so they do
not establish browser or hosted acceptance.

Nine new migrated API → SQL claim → real DOCX renderer → stored-byte hash →
authorized API download cases pass. They cover English/Arabic no-document
input, empty/invalid/technical extraction failure, retained OCR-pending scans,
fully reviewed blank successors, and both source drafts and blank templates
retried after all model agents fail. Unread scans retain their original hashes
and OCR status; they are not declared invalid. Generated Word XML contains yellow
placeholders and the appropriate insufficient-information notice. Explicit v1
retry remains independent while the original failed issuance and absolute
deadline stay byte-for-byte unchanged, with zero provider usage. The retry case
failed before the deadline fix; the reviewed-blank gap assertion failed before
its disposition fix. The six prior complete delivery pipeline cases also pass
after extracting their shared SQL/Map-storage fixture. Both package typechecks
pass. All 15 backend cases use local token and object adapters, not hosted
Auth/Storage; production deployment and real-browser visual acceptance remain
separate gates.


## November 4 — permanent access reference and durable export read boundary

Updated the permanent DO runbook with the latest successful original-CA inventory
(run41849412810, head59c6b309), the private receipt-wrapper distinction, and the
explicit isolated restore mode. Reviewed the whole selected access workflow and
its catalog-only capture and guarded fixture restore path. No cloud operation was
dispatched by this documentation change; freeze and hosted restore remain pending.

Added the caller-authorized GET `/v1/export-packages/:id` wrapper and OpenAPI
entry for the durable ordinary-export implementation being integrated separately.
It delegates membership/version/package authority to `export_package_context`;
invalid UUIDs never reach the RPC. The API, canonical generated pipeline, metadata
policy and explicit metadata campaign tests pass **44/44** together. Complete
ordinary-export backend/UI, final combined gates and hosted acceptance remain open.

The existing OCR browser harness now also closes Vite and removes its temporary
fixture on browser-launch failure. Its successful screenshot receipt is retained;
this lifecycle cleanup is not a new hosted or visual acceptance claim.

D06 legacy-contract admission: new retries/resumes of frozen plans without the
current generated-delivery and consistency contracts fail immediately with
PROPOSAL_CURRENT_CONTRACT_REQUIRED. The response details identify the exact
revision and existing explicit successor route: cancel an open legacy plan then
proposal.generate when no active version exists, or proposal.regenerate against
the accepted active version. Existing idempotency replays retain the original
response and deadline. A user cancellation now terminalizes its active issuance
rather than leaving a knowingly canceled request waiting for the time limit.
Historical frozen input/hash, accepted versions and model accounting are retained.
Two real PostgreSQL successor cases pass against the combined schema, including
no-active-version cancellation/new generation and completed-version regeneration;
receipt /workspace/output/current-issuance-contract-postgres.json. The old retry
accounting suites explicitly retain their historical142525 migration boundary.
No silent promotion, automatic new request, model call, or deployment occurred.


## November 4 — explicit current-contract recovery in the proposal interface

A rejected legacy resume now explains that its saved processing contract cannot
issue the current complete package. The recovery control validates the server's
plan/opportunity/proposal/version IDs and revisions, then requires an explicit
click before a current successor request. Cancellation, when required, and
generate/regenerate execute in one transactional command batch. Existing paid
work and the accepted version remain retained. An interrupted response reuses
the exact batch and idempotency key; a revision conflict requires fresh recovery
metadata. The interface never silently resubmits models or changes billing.

Validation: **36/36 frontend cases** (metadata rejection, accepted-version
regeneration, stable hash/batch and lost response, existing panel behavior) plus
frontend typecheck pass. The associated migration's two real PostgreSQL successor
cases are separate evidence recorded above. Hosted recovery and the final
integrated package gates remain pending.

## W10/F07 — ordinary draft and final export client durability (2026-11-04)

The proposal list, proposal editor and final export panel now request one durable
server export package through `export.package.prepare`. The server contract
reuses the current version/mode/binding package on re-entry without changing its
accepted time or deadline. The client polls authenticated metadata using server
time, fetches and hashes every required stored volume before triggering any
browser download, then rechecks current package authorization. It does not
render ordinary exports in a browser worker, upload generated bytes, or fall
back to local proposal rendering. Final requests remain `mode=final` and retain
the server's approval/source checks; generated review drafts are never treated
as approved final exports. The separate reviewed-file upload/history flow is
preserved.

All entrypoints show persistent preparation/error/recovery state. Leaving the
page or choosing Stop waiting cancels only local observation and suppresses
late download/success callbacks; the accepted server job continues. Only an
explicit Retry export preparation action sends `export.package.retry` with the
observed package revision. Polling, ordinary refresh and failures cannot
silently authorize a new deadline. Each request/read has a 30-second client
transport timeout in addition to the server's canonical 600-second preparation
clock. Backend currentness errors prevent all file-release clicks.

Local tests cover real helper control flow, all-volume hashing, failed second
volume, late currentness, browser clock skew, immutable clock during polling,
abort/re-entry, expected-revision explicit retry, final/draft separation and
component unmount/no automatic retry. The complete frontend suite passed
**339 tests in 54 files**, including the additional clock/observation guards.
Both packages' typecheck/build passed. These are local
fixtures and jsdom tests, not proof of hosted browser tab closure, actual server
lease recovery, final approval or storage transport. The corresponding durable
backend migration/worker/API and combined acceptance are separate integration
gates; no deployment or production call was performed for this frontend slice.
The historical full completed-proposal browser acceptance harness is being
adapted separately to this durable path; its explicit legacy HTTP path stays
separate.

Independent frontend review found a stale display-scope issue in the first
ordinary-client slice. The shared hook now aborts observation and clears visible
busy/package/error state on connection or explicit version changes. Editor and
ExportPanel supply the current version scope; the list keeps its explicit
clicked-version operation. Cleanup runs at commit before the new version is
painted, so an old response cannot release files or report success as the newly
displayed content. Added delayed-completion regressions for both client and
version replacement; no server cancellation or automatic retry is introduced.
Final scope-fix validation: **341/341 frontend tests in 54 files**, frontend
build/typecheck passed. The independent review finding is fixed locally; hosted
browser re-entry and ordinary backend combined acceptance remain pending.
ME05 base-validator closure (2026-11-04): schema-valid reference, source tuple,
source-page field/link, classification, review authority, draft ownership and
proposal-template diagnostics are now collected together. Grounding collects
independent candidate quotes, numeric mismatches, requirement quotes, finding
references, declared company-claim coverage and verifier identity coverage.
Reports retain at most32 deterministic diagnostics and count every independent
omitted check; source text and arbitrary error messages are never copied into
that envelope. A wrong candidate identity stops candidate-dependent judgments;
an invalid citation cannot itself justify a derived numeric mismatch. Malformed
schemas remain prerequisites. Forbidden model approval/template/policy codes
remain terminal and evidence/semantic gates are not weakened. The source-page
public validator retains its established error codes while the model boundary
receives exact field paths. No model schema, candidate adapter, paid phase pin,
wire format, prompt or correction allowance changed.

Validation: the new regression corpus initially failed15 of29 cases against the
original validators (14 valid/prerequisite controls passed). The final suite adds
an explicit duplicate-identity/coverage case; all30 new cases pass, including all
13 task registry valid controls and31/32/33/60 diagnostic boundaries. Focused14
files /345 tests pass, including historical paid verification phase hashes,
repair format, writer handoff, source-scoped repair and numeric structural
references. Backend typecheck/build pass. Context-specific blueprint/planning/
commercial/reference collection in generation.ts is assigned separately to the
operations agent; do not infer that this base slice closes those checks. Full
combined backend/frontend regression, independent code review and hosted release
remain separate gates; no provider calls or deployed correctness claim was made.

### Completed-proposal browser acceptance follows durable exports (2026-11-04)

The existing completed-plan/current-version selection and genuine Auth/private
report transport are preserved. Its browser mode now clicks the actual editor
and permits only one exact `export.package.prepare` for the selected draft;
legacy prepare/reserve/upload/complete, approval and retry mutations are denied
in that browser run. It observes the original 600-second package clock, bounded
pending reads and whole-volume readiness, then validates actual browser bytes
against independent authenticated stored downloads and each canonical export
context. The report records `durable_server_package`. The explicitly selected
historical HTTP render/upload path remains separate and records
`legacy_explicit_http_render_upload`; it is not presented as evidence of the new
browser/server preparation flow.

Local validation: **26 backend acceptance/selection tests passed**, including
6 new durable write-boundary/clock/whole-volume tests; **8 Python guards passed**;
backend typecheck/build passed. Browser-mode report duration permits observing
the original server deadline plus UI startup and independent file checks; it
does not reset or extend that server deadline. The reviewed workflow has not
been dispatched, and there is **no new hosted or actual-browser acceptance
claim** from these local tests. Pending hosted evidence still includes genuine
Auth/Storage, tab closure/re-entry and late authorization/currentness behavior.


## November 4 — read-only enabled-model binding audit

Added explicit `doks-access.yml mode=models` to diagnose the remaining enabled
Gemini configuration without guessing from the four-provider-target evaluation.
It uses the established original-CA runner, scoped read-only SQL and exact
runtime credential lookup. Its public receipt contains provider/model names and
key/project presence booleans only; aliases, project values and secret values
stay private. It makes zero model calls and no business/configuration mutation.
Conventional aliases preserve the existing legacy-provider fallback; custom
aliases cannot borrow another account's key. Owned SQL-client cleanup runs on
failure and in the workflow's unconditional cleanup step.

Validation: seven audit guard/redaction tests and eight isolated-restore workflow
guard tests pass. Inspected the complete selected access workflow including
bootstrap/restore conditions; `models` selects neither. Hosted audit is pending;
key presence alone must not be reported as provider availability or qualification.

The combined integration frontend at4ad3a22 passed **356/356 tests in56files**.
This is local jsdom evidence, not hosted browser acceptance. Later renderer
changes still require the final combined package gate.
ME05 independent review correction: W08 identified a legacy table guard regression
where checking cells separately could allow an invented certification below a
correctly cited company header. Restored the established joined-table sentence
semantics while retaining exact block diagnostics. The new certification test
fails against aaf3014 and passes with the correction; its valid table control also
passes. Focused106 tests and backend typecheck pass. Independent model review found
no additional schema-prerequisite, source-evidence or paid-pin blocker. A full
qualification against root4ad3a22 plus the collector ran: backend2,499 passed/13
failed and frontend355 passed/1 failed. Two SQL failures belong to the new legacy
retry guard's parameter ambiguity; ten require renderer-wrapper parameter
qualification; one historical migration test timed out; the frontend external
submission journey needs export-transition reconciliation. Those failures remain
open at this narrow correction and must not be reported as a full-green run.


### 2026-11-04 — generated-delivery migration preserves predecessor SQL scope

The generated-delivery wrapper now rebinds the renamed PL/pgSQL predecessor's
function-qualified parameter label. Without this, the preceding consistency
wrapper still referenced `advance_generation.job_id` after its implicit label
had become `advance_generation_before_generated_delivery`, causing a missing
FROM-clause error at real finalization. The narrow migration repair preserves
all acceptance/currentness guards. The actual `noticeDetails.test.ts` suite
passes all 51 cases against the latest consistency migration. Full composed
flexible-input runtime validation is performed in the integration tree, whose
fixture uses executor4; this isolated branch's older fixture still claims v2.
Legacy guard integration follow-up: qualified app_command.input in the job/step
join to avoid collision with generation_steps.input. The original full-run two
failures (independent discovery retry and targeted model retry) now pass in their
actual migrated suites:42 tests. The portable current-contract script now also
checks the model-job retry successor error. The isolated frontend app journey
rerun passes19/19, including external submission; its earlier full-run failure
was not reproduced, and no product behavior was changed for that timing failure.

## November 4 — native Word PAGE field interoperability

The footer PAGE field now writes begin, instruction, separator and end in separate
runs with explicit neutral formatting. The earlier single-run construction caused
LibreOffice to apply the last yellow body placeholder's highlight to the calculated
page number. This change preserves the native dynamic PAGE field and supplies no
cached or estimated number. Native TOC/PAGEREF fields, update-on-open settings,
source text, placeholder policy and immutable previously stored files are unchanged.

Six actual DOCX field/verification cases (English/Arabic, payload versions 1/2/3)
and six existing delivery pipeline cases pass **12/12**; both package typechecks
and builds pass. A separate actual render/conversion matrix passes **18 DOCX / 91
PDF pages** with zero yellow footer fields and zero outside-page text spans; page
counts match the original matrix. The base checkout's generated-delivery fixture
fails before rendering; root has separately corrected that fixture in `f22be8d`.
No unrelated fixture changes are included here, and root owns the final full-suite
run after integration.

The native TOC remains a distinct compatibility limitation: plain LibreOffice
conversion preserves the docx library's empty page-reference cache instead of
updating its index. Eleven OOXML construction variants did not solve that behavior.
Explicit index/field refresh and exported DOCX cache verification are being
qualified separately; no page estimator, static number or production layout-engine
stage is introduced by this footer fix. Microsoft Word desktop acceptance remains
separate from local LibreOffice evidence.

### 2026-11-04 — W04 ordinary draft/final export runs durably on the server

**Implemented locally:** `export.package.prepare` freezes the exact canonical
ordinary export request and required volume set, reserves the existing 10 MiB
per-file bound under the workspace lock, and queues executor-4 `render_export`.
Fresh page/re-entry keys reuse the same package/job/deadline; the immutable renderer
marker `ordinary-2` selects explicit yellow missing-input runs. Historical unmarked
requests retain their existing renderer policy. Draft and final labels/approval
rules remain distinct from generated review drafts. The old calendar-based export
count limit is removed; actual database/storage capacity checks remain.

The leased worker renders, uploads immutably, independently reads/verifies actual
DOCX bytes, and publishes existing `export_artifacts` only from verified receipts.
All required volumes must be ready before any package download. Lost upload replies
and finalization crashes reuse verified bytes. Current actor, source/OCR leaf,
reviewed source meaning, version revision and final approval are checked before
render/upload/commit and again after download reads. Request acceptance through
whole-package completion is bounded to 600 seconds; known terminal failures close
earlier. Explicit revision-checked retry is the only operation that grants a new
600-second authorization. Ready siblings and historical artifacts remain intact.

**Lifecycle:** package metadata joins the canonical backup/restore/purge contract.
Restore retains verified historical file receipts but blocks prior package issuance
and final approval; current authorization is required for a fresh draft. Unconfirmed
uploads transfer their full reservation to delayed cleanup and retries use new
private keys. Pending/ready package storage participates in the existing workspace
ledger. Frozen package/request identity has database mutation guards. Both configured
role families receive conditional privileges; user reads use current-authority RPCs.

**Evidence:** `ordinaryExportPipeline.integration.test.ts` passes 17 local migrated
SQL/API/worker/actual-DOCX cases, including two volumes, explicit final approval,
late invalidation, public backup/restore, confirmed purge, expired-byte retry,
post-read membership revocation, missing-input highlighting and exact deadline replay.
The ordinary export/structure/acceptance, prior artifact and recovery regression run
passes 86 tests across six files, with another 41 worker/API regression cases passing. Both packages' typecheck/build and all 302 frontend tests pass. Five real
PostgreSQL lock-observed races pass: fresh-key re-entry, same-key replay, source edit,
membership revocation, and competing two-volume capacity reservations. Reproduce with
`backend/scripts/testing/ordinary_export_races.py`; private receipts record exact
migration hashes and the pinned PostgreSQL image digest. These are synthetic local
checks; they do not claim production deployment, hosted-storage qualification or
native Word visual acceptance. API metadata and browser re-entry integration are
composed with the parent/W08 changes before release.
Legacy retry qualifier robustness: the joined step lookup now uses a stable local
request_input variable rather than the function-name-qualified input parameter,
so later private command wrapper renames cannot invalidate it. The actual two
PostgreSQL successor cases pass again, now including the targeted job.action
route. The actual migrated retry/capacity suites also pass52 tests against the
new local-variable definition. No paid request identity or command behavior changed.


## November 4 — definitive ordinary-package download failure recovery

The package-aware download boundary now distinguishes an authoritative missing
Storage object from a temporary dependency error. Only a genuine404 or observed
size/hash mismatch reports an exact artifact/package/revision/hash/key failure
receipt to the service-only recovery RPC. Measured size is retained for cleanup
accounting. A503 does not expire a ready artifact, restart rendering or extend
its authorization. Existing legacy/manual artifact behavior is unchanged.
The SQL recovery implementation and its actual package tests are integrated
separately; this interface change itself does not claim hosted recovery.

Validation: **35/35 combined API and flexible-input runtime cases** plus backend
typecheck passed. The model-only flexible-input fixture now stops when its model
plan completes, before claiming the separately queued local v3 projection job;
it does not fabricate a projection/issued receipt. The dedicated generated
delivery pipeline continues to prove real projection/render/whole-package
issuance separately. This resolves six fixture failures exposed after the real
advance_generation renamed-parameter defect was fixed.

### 2026-11-04 — ordinary package definitive byte-failure recovery

A service-only `report_export_package_artifact_failure` receipt accepts only a
known storage404 or a measured byte mismatch. It checks current actor/source/final
approval and exact package revision, artifact ID, original hash and private key.
Stale receipts make no change. The prior immutable hash/receipt remains in history;
the package becomes blocked and an explicit authorized retry creates a new key and
artifact. Corrupt bytes enter canonical cleanup with measured storage accounting;
a definitive absence releases only the known missing artifact. Transient storage
errors must never invoke this receipt. No read automatically retries or renews a
request. `artifact_context` supplies the package ID/revision for API-side CAS.

Twenty ordinary pipeline cases now pass, including actual rendering before missing/
corrupt receipt, stale CAS, denied user execution, current-source rejection and explicit
repair. Backend typecheck passes. The root API integration owns invoking this receipt
on authoritative404/hash/size failure and preserving transient503 behavior. The
predecessor job-action wrapper uses its separately fixed stable request alias; the
redundant ordinary-export rename rebinding is removed accordingly.
G10 prebillable file capacity (2026-11-04): automatic issuance now acquires one
request-bound20MiB allowance before its first new model reservation, under the
workspace lock. This is exactly the existing maximum two delivery volumes times
10MiB per artifact, within the existing250MiB storage policy. The canonical ledger
includes the allowance, so concurrent input/export writers cannot steal it.
Required renderer3 artifacts receive that allowance atomically when their exact
pending slots reserve storage. Repeated context/reservation attempts do not add
allowances; existing duplicate model reservations retain their rejection policy.
Terminal requests release only unspent future capacity, preserving ready/pending
artifact bytes and every provider usage row, including unknown receipts. Historical
requests retain null capacity-version pins; no prompt, paid hash, token/daily cap,
free-only/billing policy or provider configuration changes were made.

Validation: both lockfiles reinstalled successfully after removing only obsolete
worktree dependencies to recover disk space. Backend/frontend types and builds
pass. Focused deadline/capacity regression32 tests passed; the added capacity
managed-only-role test subsequently passed with all6 capacity lifecycle cases.
Workflow agent independently proved the original unchanged full-storage reservation
red now rejects before provider_usage, held20MiB excludes a competing10MiB upload,
a1MiB remaining upload fits the exact250MiB boundary, and duplicate model-call
rejection leaves usage/allowance unchanged. Four real PostgreSQL multi-session
cases pass with canonical migrations plus the ordinary152913 storage wrapper:
concurrent allowance idempotence, competing upload versus allowance serialization,
required-artifact transfer and unused allowance release, and source rejection
without reservation mutation. Receipt:/workspace/output/proposal-capacity-postgres-races.json
contains exact migration hashes, synthetic-only fixture identity and lock evidence.
Source/snapshot retention, early storage-error terminalization and unknown provider
usage preservation are explicit tests. No provider calls or production mutations.

Remaining: root's independent SQL review, final combined sequential regression,
actual dense renderer capacity/OOM qualification (separate component), release,
and hosted stopwatch/download acceptance. Structural SQL races do not establish
semantic correctness or real DOCX rendering. The workflow-owned capacity tests
remain in their separate root commit; this component adds the lifecycle/managed
role tests and portable PostgreSQL script only.

### 2026-11-04 — ordinary download lock boundary and expired replay correction

Independent review reproduced a source-change race in final download authorization:
the package source check preceded the legacy delegate's workspace-lock wait. The
wrapper now acquires that lock before checking package/source/approval currentness,
then keeps it through the existing final authorization. A real PostgreSQL contender
observed waiting is denied with `STALE_INPUT` after a source edit; the former wrapper
returned authorization in the same race. The portable ordinary race suite now passes
six cases, including this final-read boundary (synthetic database artifact receipts;
actual DOCX bytes remain covered separately by the pipeline suite).

Expired idempotency rows are deleted only for the exact authenticated actor/operation/
key after the workspace lock, before inserting their successor receipt. Re-entry still
reuses the same package, job and original deadline. The ordinary pipeline suite passes
21 cases including expired API receipt replay, with no duplicate job or clock renewal.
No customer data or external calls were used.

### 2026-11-04 — G10 actual generated-package capacity transfer

Four additional cases in `generatedDeliveryPipeline.integration.test.ts` exercise
migration160125 against the actual projection, leased renderer, DOCX verification,
whole-package completion and issuance receipt. For both combined and separate
technical/financial outputs, the existing20 MiB complete-file allowance transfers
into exact10 MiB artifact slots without double counting; independently verified
actual bytes replace those reservations, the request becomes issued, and any unused
allowance is released. The original accepted time/deadline remain unchanged.

A changed source prevents capacity transfer and rendering; its terminal failure
receipt releases only unused allowance and retains the accepted proposal version.
A deliberately injected delegated-capacity failure rolls back the allowance decrease
and all artifact reservations atomically. The full generated-delivery suite passes
17 cases and backend typecheck passes. These new cases prime the canonical
pre-billable capacity helper directly with synthetic accepted/verifier records;
actual model-reservation admission and concurrent storage writers are covered by
the separate capacity RPC/PostgreSQL suites. No paid model, external storage or
production action occurred in these checks.


### 2026-11-04 — G10 measured input bounds and pre-billable output capacity

The independent capacity regression reproduced a model reservation being admitted
while the canonical 250 MiB storage ledger was full. After integration of migration
`20261104160125`, the unchanged regression rejects before any provider reservation,
renderer invocation or object write, preserving the accepted source and saved draft.
A second case proves that the existing two-file 20 MiB output allowance is acquired
once, appears in the shared ledger, excludes a competing 10 MiB upload when only
1 MiB remains, and retains the original request deadline. Repeated reservation
commands keep the existing duplicate-call rejection and create no extra usage or
allowance. Unknown deletion bytes remain accounted for.

`proposalCapacity.integration.test.ts` passes **14/14** on the integrated root.
Both package typechecks pass. The suite exercises the actual migrated SQL admission
boundaries at 999,999/1,000,000/1,000,001 extracted characters and 199/200/201 PDF
pages; the page-count tests deliberately do not claim actual PDF parsing or OCR.
Three sequential actual API → SQL → DOCX → immutable Map-storage receipt →
authorized download cases preserve complete source-block coverage and verified
hashes at 4,000 English, 100,000 mixed and 1,000,000 Arabic characters. Their local
measured totals were 266 ms, 617 ms and 2,812 ms respectively. These repetitive
synthetic inputs produced 970,302, 977,062 and 981,948-byte files; compression and
local adapters make these measurements unsuitable as hosted latency guarantees.

The same suite proves that dense authored table content is genuinely admitted and
persisted by the authorized API before projecting it into a render model: 10,000
mixed-language cells, 50,000 short cells, and 329,000 short cells across 658 tables.
The last is the largest complete-table instance of this specific fixture family
within the existing HTTP and JSONB input limits, not a global maximum across every
valid encoding. One additional table is rejected by the existing 2 MiB JSONB bound
without changing the saved revision. Every admitted cell survives the immutable
payload and rendering projection. These three admission checks do not themselves
prove successful native rendering of those tables. The separate native renderer
work retains its original failure receipts and must complete render **and** verify
acceptance before that gap can close.

Receipt: [proposal-capacity-local-20261104.json](evidence/proposal-capacity-local-20261104.json).
It records the complete 14-case denominator, migration hashes, source/font/lockfile
hashes verified stable before and after the run, input bounds and actual timings.
Synthetic local tokens and Map storage are explicit; no provider, customer data or
production calls were used. The request-wide 600-second deadline races are covered
by the separate real-PostgreSQL suite, not inferred from these local timings.
Release, hosted storage/authentication, admitted concurrency, network/provider
latency and the production issuance SLO remain separate acceptance gates.


## November 4 — hosted model-audit credential binding correction

Run41863551387 at6ee38ac passed original cluster CA/hostname verification and
read-only readiness. The new model-audit step then failed before its catalog
read because its workflow step omitted DIGITALOCEAN_ACCESS_TOKEN, which the
scoped observer requires to obtain short-lived database credentials. Both
owned-client and credential cleanup succeeded; bootstrap/restore/model calls
were skipped. This is a diagnostic wiring defect, not a TLS regression or a
provider availability result. Direct GitHub job logs supersede stale CLI status
responses that still reported the job queued.

The selected step now receives the existing repository credential through the
normal environment binding. A missing binding fails explicitly before any
cluster operation. Eight redaction/binding/cleanup tests pass, including exact
workflow-step wiring. No secret value was printed and no provider configuration
was changed. The corrected hosted audit is pending; use connected GitHub job
steps/logs for fresh execution evidence.

Regenerated OpenAPI for the two canonical ordinary package commands added by
the export implementation; its authenticated GET boundary was already recorded.
The combined actual ordinary SQL/API/DOCX suite passed20/20 after integrating
definitive missing/corrupt file recovery; later lifecycle fixes require their
separate focused and final combined evidence.
### 2026-11-04 — ordinary export retention and null-guard closure

Independent lifecycle/atomic-release review identified three fail-open/retention
edges and an existing function-authority drift. Missing or JSON-null saved renderer
markers now fail with `EXPORT_PACKAGE_INVALID`. A null artifact-failure reason is
rejected before any valid receipt, bytes status, audit, or quota accounting changes.
The canonical maintenance implementation retains a package's referenced current job
as its existing completion proof, matching retained delivery-artifact provenance;
an indexed lookup excludes only those references, so unrelated terminal jobs still
expire under the configured policy. No completion state is fabricated.

The generated-delivery queue classifier also preserves the established
`STABLE SECURITY DEFINER` contract: its delegate reads database state, so declaring
the wrapper immutable and dropping its definer property were incorrect. Its owner,
ACL and search path remain unchanged. The separate managed atomic-release authority
gate must be rerun on the composed revision before deployment.

All five new regressions reproduced the prior defects, then passed after these
changes. The aged-maintenance case renders a genuinely approved technical/financial
package, ages its job beyond the maximum366-day test boundary, invokes actual public
maintenance, verifies the unrelated old job is pruned, then downloads/verifies both
DOCX volumes and re-enters the same package without changing its job or deadline.
The ordinary suite passes26 cases; related artifact/round-robin/wake/fairness suites
pass188 cases, and backend typecheck passes. These are local synthetic receipts,
with no production, provider or email calls.

## November 4 — bounded native document construction and renderer admission

Actual authenticated authoring inputs exposed V8 heap exhaustion at 128/256 MiB
for 10,000 cells, and at 128 MiB for 10,000 short paragraphs. The renderer now
keeps native headings, TOC, styles, fonts and footer in a small skeleton, prepares
ordinary paragraph/bullet XML with native numbering, and streams native table
rows into ZIP compression. Repeated rows reuse their exact XML while still
emitting every row and cell. Ragged rows now retain values beyond the supplied
header count, with empty padding only; the prior renderer lost those values and
the canonical content verifier correctly refused the file.

Six frozen rectangular `word/document.xml` goldens remain byte-identical to
renderer `90e8090`. Six paragraph/bullet goldens normalize only docx's global
bookmark allocation IDs and independently check TOC, bookmark and numbering
references. Ragged content, repeated-row keep-next, escaping, missing/duplicate
slots, PAGE fields and admission/cancellation tests pass **34/34** after the final
footer correction; the preceding combined pipeline/worker selection passed
46 cases. The final footer uses explicit native XML components: independent
review found that the earlier `fromXmlString` API inserted an invalid `undefined`
wrapper despite LibreOffice's visually successful conversion. New tests reject
that wrapper. Earlier visual receipts remain historical, and final visual QA
must bind this corrected source.

The process admits one renderer at a time, includes FIFO waiting in its existing
30-second attempt deadline, removes expired/canceled waiters before spawn, and
kills/reaps active children on cancellation while preserving the server's typed
request/lease reason. This is process protection; the separate database renderer
lane keeps ordinary queued jobs unclaimed without consuming attempts. The child
heap remains 128 MiB and no source/input/output cap has been reduced.

Measured offline native evidence includes 329,000 cells and 1,787,000 normalized
sparse cell positions. Exact row reuse reduced the latter from a 30-second
render timeout to 10.74 seconds; combined rendering and the staged asynchronous
verifier then completed in 49.35 seconds under a 640 MiB/one-CPU, network-disabled
container with the full application import graph loaded. These measurements
precede the final footer and later verifier/deadline changes; final exact-source
native qualification, the stronger minimal sparse fixture, storage readback and
request-wide/hosted acceptance remain separate pending evidence.

The original specification still requires a live TOC plus update-on-open and
instructs users to update all fields/the entire TOC in Word and save before
submission. Stable LibreOffice 7.4.7.2 exposes zero document indexes when importing
the original native fixture; plain conversion preserves empty page-reference
caches. No refreshed-cache or Microsoft Word desktop qualification is claimed,
and no estimated page number or production office conversion stage was added.


### 2026-11-04 — G10 density and uneven-column regression follow-up

The actual authorized authoring API admits 810 full tables containing 405,000
explicitly empty cells within the existing 2 MiB JSONB input bound; the next full
table is rejected without changing the saved revision. It also admits the schema's
100 sections × 100 short paragraphs. Tests preserve every supplied cell/paragraph
and its order through the saved revision, immutable delivery payload and render
projection. These are additional concrete fixture families, not proof of a global
maximum across all admitted shapes; sparse rows with implicit padding are a further
density axis requiring assessment. Their frozen models were handed to the native
renderer owner for independent process/memory and full-file verification.

A separate actual API → DOCX regression exposed accepted rows wider than their
header list. The former renderer built cells from the header count and omitted
extra values. Existing final verification correctly rejected the resulting file
with `EXPORT_CONTENT_MISMATCH`; this was an availability failure, not a false claim
of successful delivery. The renderer owner's column-width repair retains every
value and supplies empty padding without inventing column labels. The unchanged
regression now verifies all 500 supplied cells after rendering.

`proposalCapacity.integration.test.ts` passes **17/17**, and both package
typechecks pass. [The density receipt](evidence/proposal-capacity-density-20261104.json)
records that run and its stable source/font/lockfile hashes. The original 14-case
receipt remains intact. This receipt is scoped to the recorded implementation;
the final merged bounded verifier and native runtime are separate acceptance.
Receipt capture now also includes `boundedDocx.ts`, `boundedDocxArchive.ts` and
`boundedXml.ts` when present, for the final integrated rerun. No native large-file
qualification, hosted timing, provider call or production deployment is claimed
by these API/persistence density checks.

### 2026-11-04 — bounded verification of large authorized DOCX content

**Implemented locally:** Word verification now validates the ZIP central and local
indexes, exact entry boundaries, duplicate paths, descriptors, actual expanded
sizes and CRCs before accepting the file. Raw DEFLATE is fed 512 compressed bytes
at a time; a 1 MiB callback limit is enforced. UTF-8/XML is parsed incrementally with
bounded tags, depth and namespace state. No complete document XML, parsed tree or
actual-paragraph list is retained. The existing 10 MiB archive limit stays; the
export-only expanded-document allowance derives from authorized text and native
paragraph/cell structure, including blank cells. Original-upload limits remain
unchanged. This admits highly compressible valid tables while refusing expansion
unrelated to the authorized model.

The same verifier compares ordered paragraphs, exact table/grid/row/cell content
and blank padding, yellow gap runs, native TOC text, enabled field updates,
headers/footers, metadata and internal relationship targets including embedded
fonts. Ragged model tables use the maximum header/row width with blank padding;
no supplied overflow cell is discarded. DTDs, unsafe relationships, tracked
changes, malformed XML/ZIP and missing referenced parts remain rejected. Independent
review also exposed two inherited visible-content bypasses: a visible TOC suffix
was stripped, and alternate Word namespace prefixes could evade text collection.
Both now have actual DOCX mutation regressions; expanded names are canonicalized
and visible text is never discarded as a field instruction.

**Responsiveness:** synchronous compatibility and asynchronous runtime entrypoints
consume the identical validation generator. The runtime version yields to the event
loop during scans and supports cancellation without returning a partial pass.
Both direct runtime callers (deliveryBytes, reused by ordinary/generated delivery,
and the API reviewed-DOCX completion path) await it. Current source/lease/approval
checks after verification remain the caller's authority boundary.

**Evidence:** 54 verifier/delivery/field cases pass, covering malformed/truncated/
duplicate ZIP/XML, real CRC mismatch, namespace aliases, dangerous metadata,
field settings, text/gap changes, blank/shifted/ragged cells, a high-compression
callback bound, concurrent heartbeat and cancellation. The 6-file composed API/
DOCX/acceptance run passed 93/96 with 3 unchanged 5-second generated-pipeline test
timeouts under concurrent local load; isolated rerun passed 13/13 at the original
threshold. Full frontend passed 355/356 with an unrelated successor-button timing
assertion; its unchanged isolated file passed 25/25. Both package typechecks and
builds pass. These observations do not substitute for the parent's final combined
full-suite run.

Actual API-admitted 405,000-empty-cell native DOCX verifies asynchronously under a
128MiB Node heap in 8.36 seconds, with the largest inflation callback 67,320 bytes;
810 timer callbacks ran and the measured longest timer gap was 31 ms. Its 159 MB
expanded package is checked without raising original-upload limits. The 329,000-cell 200 MB XML sample also passes the final asynchronous verifier in
10.18 seconds at a 128 MiB heap, with a 68,546-byte maximum inflation callback
and a measured 15 ms timer gap. Final Deno full-runtime
image receipts are coordinated with the streaming renderer and bind all helper
hashes. These are synthetic offline capacity measurements, not hosted Storage/Auth,
production load qualification, a universal table maximum or a 600-second service SLO.
No production/provider calls, deployment or billing changes were performed here.

### 2026-11-04 — corrected hosted model binding audit

[Run 41869042836](https://github.com/salahassi/tenders/actions/runs/41869042836)
at `bc8e5709183fd228ae1bac207e643e2413e9c9fd` completed successfully. Direct
GitHub job evidence confirms original cluster CA verification, scoped catalog
read, owned SQL-client cleanup and temporary credential cleanup. Bootstrap,
restore, business writes and provider calls did not run. The prior diagnostic
credential-binding failure is resolved by this exact hosted execution.

The enabled OpenAI and QwenCloud model bindings each have their configured key;
the enabled Gemini binding does not. Key presence proves neither available
credit nor successful inference. The earlier provider quota/credit failures
remain historical measurements, not a fresh result from this read-only audit.
The intervening scheduled credential workflow 41860893513 performed alias
discovery only; its bind, reload and recover jobs were skipped, so it provides
no evidence of refreshed keys or repaired provider availability.

The sanitized [receipt](evidence/model-binding-audit-20261104-41869042836.json)
contains no aliases, keys, project values or customer content. The permanent DO
runbook links it and records use of direct job evidence when cached CLI metadata
still reports a completed run as queued. This closes diagnostic wiring and key
presence verification only; live prompt qualification, provider availability,
final integrated release and hosted proposal acceptance remain separate gates.
### 2026-11-04 — independent render admission without spending queued attempts

Migration `20261104163406_serialize_local_document_rendering.sql` replaces the
existing blanket one-running-job workspace index/claim guard with two explicit
lanes: one non-render job per workspace, plus one document renderer globally.
The previous production contract already serialized all running jobs; this change
allows useful model/poll/projection progress during rendering, without increasing
model-to-model concurrency. Both partial unique indexes enforce workspace lanes;
a private transaction advisory mutex makes global render selection and canonical
lease publication atomic. A contending renderer stays queued without attempts,
failures, lease or deadline changes. Model reservation limits, fairness, source and
issuance guards, executor compatibility, lease recovery, and cancellation remain
in the canonical paths. Wake eligibility mirrors the split lanes.

Eleven new migrated SQL tests cover mixed render types, actual wake+claim progress
for model/poll/projection, one non-render lane, old executor exclusion, inference
reservation saturation, expired render recovery, twelve accepted ordinary export
packages and an expired package still waiting in the queue. All 254 focused
queue/wake/background/artifact/ordinary tests and backend typecheck pass.

`backend/scripts/testing/document_render_admission_races.py` additionally passes
six real PostgreSQL multi-session cases. Primary public v4 claim races use the
unchanged singleton production schema and observe contenders waiting on actual
workspace locks. The twelve-package simulation preserves each original 600-second
clock and unclaimed job row while each package receives one lease. Its verified
storage receipts are synthetic; actual DOCX bytes are exercised by the separate
pipeline tests. A recovered real export lease rejects the previous worker with
`STALE_LEASE`. The cross-workspace global-mutex defense explicitly relaxes singleton
uniqueness only inside the isolated fixture and calls the unchanged production
selector under canonical workspace locking/lease publication. While the first
render lease is uncommitted and invisible, the second render cannot start, but a
model job progresses; a second non-render remains queued. This is not a claim of
multiworkspace product support. Receipt with exact migration hashes:
[document-render-admission-postgres-20261104.json](evidence/document-render-admission-postgres-20261104.json).

This admission proof concerns logical leases. The native process semaphore and
termination/reap tests separately fence an old physical child after cancellation
or expiry. Neither the queue simulation nor lease count proves instantaneous CPU
reap or hosted twelve-document throughput. No production, provider or email calls
were made, and no request clock was extended by waiting.


### 2026-11-04 — reconcile the plan with integrated work and retained failures

The plan ledger now distinguishes completed local integration of ordinary exports,
full diagnostic collection, historical recovery and render queue admission from
the remaining dense-document, reviewed-Word and ambiguous-upload corrections.
Earlier full-run failures are correctly recorded as a mixture of real renamed
function defects and fixture assumptions, not all dismissed as test-only issues.
No deployment, final combined pass, provider availability or hosted acceptance is
implied by these documentation updates. The draft PR records the same boundaries.
### 2026-11-04 — explicit final release contracts and observed worker limits

The release source gate now requires all 19 currently integrated additive
migrations, including the current issuance contract, ordinary export packages and
pre-billable file capacity. The manifest explicitly binds ordinary renderer
`ordinary-2`, issuance contract 1 and file-capacity version 1 alongside worker 4
and delivery renderers 1/2/3. Removing a required migration before re-freezing,
downgrading a capability or substituting a JSON boolean for its version fails.
A forthcoming global renderer-admission migration must be added before the final
manifest is frozen; this entry is not approval to freeze or deploy this revision.

The atomic transaction additionally checks the actual new RPC and private-helper
permissions, ordinary metadata RPC, table and column privileges, row security,
capacity column types/defaults/nullability, validated capacity constraint and
enabled issuance triggers. Existing row/owner/ACL/security-definer invariants
remain strict, and now include the original columns' individual ACLs. Tests inject
missing RPCs, inappropriate grants, disabled row security and disabled capacity
checks, verifying that the entire schema/receipt transaction rolls back. Catalog
checks remain distinct from the actual mixed old/new worker claim and competing
capacity-writer behavior suites.

Before any SQL-client creation, schema application or workload patch, the rollout
reads the target worker's actual limits and requires at least 640 MiB memory and
one CPU, the measured container envelope. Exact decimal quantity parsing accepts
stronger supported limits and rejects missing, malformed or lower limits. It
never changes resources, requests, replicas or billing. The sanitized successful
receipt retains the observed limits and normalized quantities while explicitly
reporting hosted load as unqualified. Node contention and provider/network latency
remain hosted acceptance requirements.

Local focused validation passes 4 release tests (including real migrated PGlite
rollback/replay fault cases) and 10 rollout fault-injection tests. Before these
guard additions, the 19-migration real PostgreSQL reconstruction/public restore
check passed all 8 assertions with explicit Auth/Storage stubs, managed-schema
checks passed 11, Kubernetes helper checks 13, and model-audit redaction checks 7.
The initial broader operations run had 335/337 pass: it exposed the queue classifier
security-definer drift (fixed separately by c3aad92 and verified by the now-passing
atomic gate) and a historical recovery fixture expecting a legacy guard before
the new current-contract rejection (owned by the separate recovery qualification).
A final scoped operations/reconstruction rerun is pending the remaining integrated
SQL changes. No hosted operation, provider call or production mutation occurred.

G12 hashing now includes every local frontend renderer helper, package manifests
and lockfiles, including newly added untracked source during qualification. The
next matrix will therefore bind the streaming-table helper as well as the renderer.
No new visual pass is claimed while dense rendering and verification are changing;
existing footer-only evidence and the open native-TOC compatibility limitation
remain unchanged.

### 2026-11-04 — twenty-migration release guard verification

The required source set now includes global document-render admission migration
`20261104163406`; the manifest records `global_renderer_limit: 1`. Before rollout,
the atomic gate checks its private volatile Boolean helper/empty search path,
active-render index and both valid unique workspace lane indexes, and rejects
the old blanket index or a direct service-role execute grant on the helper.
These are catalog prerequisites; the independently retained six-case PostgreSQL
race receipt proves the actual logical admission behavior. The worker resource
receipt now additionally reports validated CPU/memory requests and desired replica
count, preserving missing requests as null and explicit zero as zero.

On the composed source containing lifecycle c3aad92, historical qualification
d15aa28 and global queue dfac510, all **342 operations Python tests pass** in
106.5 seconds, including 17 injected SQL rollback faults and the final capability
and observed-resource negatives. The real PostgreSQL managed reconstruction and
canonical source-review/delivery backup/restore harness passes **8/8 checks over
all 20 migrations**. Its source hashes are retained outside the repository in
`/workspace/work/ai-resume/due-diligence/phase2-operations/release-final/cloud-restore-postgres-20.json`;
the operations log is `ops-20.log` in the same directory. Local Auth/Storage are
explicit stubs; this is not hosted file or renderer acceptance.

These receipts precede pending deadline metadata and storage-upload ambiguity
corrections. The final source manifest, cloud restore and combined application
gates must use their later exact hashes. No manifest was frozen for deployment,
no hosted workflow was dispatched, and no production resources were changed.


### 2026-11-04 — G10 sparse-table extremes and derived shape bound

Two further actual API admission cases retain their separate frozen inputs. With
ten named headers and fifty empty row arrays per table, the current JSONB ceiling
admits 3,574 full tables: 178,700 explicitly supplied rows and 1,787,000 implicit
data-cell positions after rectangular rendering. With empty headers and the
shortest section metadata (unique one-character keys/title, shared volume), it
admits 4,143 full tables: 207,150 rows, 2,071,500 data-cell positions and 41,430
header cells. The next full table is rejected in both families without changing
the saved revision. Every header and original row array survives persistence and
projection; no input cap or schema restriction was added.

The test derives a conservative normalized-table-cell bound instead of treating a
convenient sample as the entire admitted range. It measures JSONB cost for all
2,760 cheapest legal width/row/header-count shapes, including establishing a wider
ragged row beneath fewer headers. Ten empty headers and fifty empty rows maximize
cells per byte: 510 normalized cells cost 504 bytes. Nonempty strings and further
supplied cells add storage without increasing this shape's width. Actual SQL
confirms array-element additivity and the minimum required wrappers: 284 fixed
input bytes and 204 bytes per section. Each section holds at most 100 tables, each
table at most 510 normalized cells. These facts give a conservative ceiling of
**2,113,160 normalized table cells** within the current authoring JSONB/schema
contract. The accepted full-table fixture contains **2,112,930**, only 230 below
that bound; a partial final table may occupy some remainder. This is a table-cell
count bound, not a universal document-memory or latency guarantee.

The integrated suite passes **19/19**, and both package typechecks pass on the
current renderer (`178eb04`) and bounded verifier (`116fc55`).
[The sparse density receipt](evidence/proposal-capacity-sparse-20261104.json)
records all 19 cases, the derivation, actual admission sizes and stable hashes for
source files including all three delegated verifier helpers. Earlier 14/17-case
receipts and the named-header fixture are retained. Native render/verification
under process/container limits is owned by the separate renderer qualification;
these API checks do not assert it passed, nor hosted concurrency or production SLO.
No external providers, customer data, deployment or production writes were used.

### 2026-11-04 — stop local render/verification at the existing request or lease deadline

Generated and ordinary workers now derive a monotonic CPU budget from the current
DB clock, validated lease and existing accepted request. The full measured RPC
round trip is subtracted conservatively. Later context reads may shorten that
budget but never extend it or restart the 600-second authorization. Canonical
request expiry, lease expiry and the renderer's separate 30-second attempt limit
retain their distinct existing error codes. Timers are cleared on every exit.
The renderer's independently committed optional signal hook cancels queued work
without spawning and kills/reaps active work; the same signal reaches incremental
verification and hashing boundaries. Final SQL source/actor/approval/lease checks
remain authoritative before any successful receipt.

Existing service context RPCs add only `server_now`/`lease_until` metadata; the
issuance job-state RPC also refuses absent, expired or canceled leases. No new
migration filename, permission surface, admission policy or accepted/deadline
identity is introduced. Reviewed uploads and downloads of already-issued files
use only the incoming request signal; they do not create a fresh issuance clock.

Within one worker invocation, independently fetched bytes may reuse the immediately
preceding verification only when a private receipt proves the same byte SHA-256,
size and exact current render-model SHA-256. Input bytes and the model used during
yielded verification are snapshotted. Caller-created receipts, changed models,
changed bytes and historical/resumed objects receive complete verification. Receipt
field mutation cannot alter the private proof. The optimization does not skip
storage readback, hashing or any current authorization check.

Local evidence: 29 focused budget/proof/worker/issuance cases pass, including server
clock independence, RPC wait, no renewal on refresh, current lease cancellation,
no file upload after cancellation, null/expired lease refusal, fake proof/model
mutation and canceled readback. The actual ordinary/generated/early delivery/API
pipeline regression passes 72 cases in four files. Both package typechecks/builds
pass. The shared native renderer signal hook and final integrated Deno memory/
timing qualification belong to their separately recorded renderer evidence; this
change does not claim hosted acceptance, final integrated full-suite success or
production deployment. No provider/production calls or unknown-usage changes.


### 2026-11-04 — G10 alternating Arabic/Latin paragraph admission

A separate density fixture covers formatting-run expansion rather than table or
paragraph count. The actual authoring API accepts 69 distinct paragraphs of
20,000 characters each, alternating Arabic and Latin letters after a unique
paragraph prefix: 1,380,000 characters and 2,073,032 JSONB input bytes. The next
paragraph exceeds the existing request/storage contract and is rejected without
changing the saved revision. All characters and paragraph order remain exact in
the stored response, immutable delivery snapshot and rendering projection. Unique
prefixes prevent a repeated-paragraph cache from hiding this workload.

The capacity suite passes **20/20**, and both package typechecks pass.
[The direction-density receipt](evidence/proposal-capacity-direction-20261104.json)
records this run and source hashes verified stable before and after execution.
All earlier receipts are retained. The frozen native input was handed to the
renderer and verifier owners; this new API case does **not** assert native success
within 128 MiB/30 seconds or final document-XML verification. Any resulting native
repair and stricter verifier guards require their own final combined rerun. No
input ceiling was changed, and no provider or production calls were made.
### 2026-11-04 — preserve ordinary export cells wider than the header row

`buildExportModel` now copies every authorized source cell instead of projecting
rows through the header count. Source rows and literal zero values survive; the
native renderer alone pads the widest table with empty cells and empty headings.
This changes new render projections, not immutable historical artifact bytes.

The new local integration test failed before the fix because a unique source
cell and `0` disappeared. It now passes through actual authenticated fixture API
prepare, migrated SQL immutable request snapshot, ordinary background worker,
object readback and authorized download. An independent native XML assertion
checks all three columns, zero, blank header padding and short-row padding; the
stored source remains byte-for-byte equivalent as JSON. This uses only synthetic
local session/object transport, not hosted Auth or cloud Storage.

Local validation: 27 ordinary pipeline/ragged cases, eight projection/structure
cases and two native renderer cases pass; both package typechecks/builds pass.
The renderer dependency is the separately committed native streaming/ragged
implementation `178eb04`. Final composed suites, hosted acceptance and deployment
remain separate release evidence. No production or provider calls.

### 2026-11-04 — explain unresolved file storage without unsafe retry

Operations now displays optional aggregate storage-write uncertainty from the
server: unfinished uploads, the already-counted retained bytes, files requiring
administrator checks before deletion, and historical records whose physical
usage remains unmeasured. These categories do not invent usage or add the held
bytes to the total again. Private paths and identifiers are not exposed. Older
status responses without the new field remain usable.

A cleanup blocked by STORAGE_QUIESCENCE_REQUIRED no longer offers a retry that
cannot satisfy the missing reconciliation; other checked cleanup retries remain
available. The missing-heartbeat explanation also no longer assumes a paused
Supabase project for this DigitalOcean deployment. Three focused UI tests and
frontend typecheck pass, including the absence of an unsafe/ineffective retry and
compatibility with the old response shape. Backend metadata, storage fencing,
operational retirement, final combined checks and deployment retain separate
implementation and acceptance evidence.

### 2026-11-04 — bound native mixed-script run expansion from authorized content

The incremental DOCX verifier now counts the exact historical ASCII/non-ASCII
run segmentation lazily from the trusted render model and adds conservative
native run-property overhead to its existing text/paragraph/table allowance.
It does not infer an allowance from ZIP metadata or allocate all run objects.
Preflight yields every 4,096 runs, including within one paragraph, so request
cancellation remains effective. The 10 MiB compressed file cap, 512-byte inflater
input chunks, 1 MiB output-chunk guard, CRC/local/central agreement, strict XML,
field/table/content rules and original-document 40 MiB upload guard are unchanged.

A new native-XML fixture repeated actual two-script Word run fragments into twelve
20,000-character paragraphs. It failed the old expanded-content budget and now
passes full asynchronous validation above 40 MiB. The same text-length model with
contiguous script cannot borrow that allowance and still fails the budget; timer
heartbeat and cancellation assertions pass. Exact segmentation is checked against
the historical capturing split over 9,331 short strings plus punctuation/Unicode
cases. The native fragment's formatting overhead is checked against the allowance.

Local validation: 49 bounded-verifier/run-budget cases pass; both package types
and builds pass. No claim is made that this synthetic XML fixture proves the
native renderer's full admitted 69-paragraph direction-density case: final Deno
render/verify, process/container memory and timing evidence remain with that
separate qualification. No hosted or production/provider calls were performed.

### 2026-11-04 — lazy native text runs for admitted direction-density input

The actual authenticated authoring fixture containing 69 distinct 20,000-character
Arabic/Latin alternating paragraphs exhausted the original 128 MiB child V8 heap
in 2.2 seconds. Paragraph grouping alone did not remove this failure. Body and
cell text now serialize one native run at a time into the compressed archive;
empty native paragraph/row wrappers retain properties and relationships. The
renderer and verifier share the exact historical segmentation iterator. A bounded
64-entry cache reuses short native runs, and repeated small rows retain their
exact positional properties. Content is neither truncated nor capped by these
optimization bounds. Native headings, TOC, numbering, footer and fonts remain.

At unchanged child heap and attempt deadline, the same frozen admitted fixture
rendered in 4.77 seconds with 397,221,888-byte full-application container peak,
producing 295,825,209 bytes of document XML. This render-only receipt is preserved
separately from final combined asynchronous verification. The original failed
receipt is retained. The shared final verifier separately accepted those bytes;
final exact-source Deno and worker lifecycle qualification remains pending.

All 36 scoped renderer, footer and process-isolation cases pass, including frozen
native XML goldens, ragged rows, repeated-row keep-next, long legacy paragraphs,
20,000-character alternating paragraphs and 2,000-character alternating cells.
Frontend typecheck passes. Modern model paragraph/cell bounds are 20,000/2,000,
but delivery envelopes do not impose those bounds universally: source chunks
allow 12,000 and legacy section bodies allow 100,000 characters. The fix therefore
streams body/cell runs independently of the modern authoring bounds. No provider,
production or billing calls were made.

### 2026-11-04 — actual final native renderer and asynchronous content validation

The frozen synthetic admitted matrix passes all seven cases through the actual
Deno child and final asynchronous DOCX verifier, with the API/worker application
imports loaded. Sources, inputs, immutable runtime image and output hashes are
recorded in `evidence/native-renderer-capacity-20261104.json`; raw DOCX files remain
in the local output evidence directory. No provider or hosted requests occur.

At the unchanged 128 MiB child heap, 30-second render attempt, 1 CPU and 640 MiB
container limit, the 4,143-table fixture preserves 2,112,930 normalized cells:
11.62 seconds rendering and 56.13 seconds including full content verification.
The 1.38-million-character alternating-script fixture takes 3.44 / 22.91 seconds.
The 405,000 explicit empty cells, 329,000 nonempty cells, 50,000 cells, 10,000
paragraphs and ragged-row fixture also verify exactly. The matrix leaves no child
running and observes at most one child. Peak container usage is 649,199,616 bytes,
only about 21.9 MB below the limit; this is measured offline evidence with modest
headroom, not a production concurrency or latency guarantee. A separate actual
worker two-volume/readback/deadline qualification remains outstanding.

### 2026-11-04 — clean installs and combined frontend verification

Both package lockfiles installed successfully with `npm ci`. On source
`35c62c4` plus the count-label wording corrections committed with this entry,
frontend typecheck, all 359 tests across 57 files (`--maxWorkers=1`), and the
production build pass. The Vite large-chunk advisory remains. The panel uses
count-neutral wording for unsettled uploads and administrator storage checks.
Hashes and check scope are retained in
`evidence/final-frontend-checks-20261104.json`. These checks do not establish
backend integration, production deployment, or hosted acceptance; the final
backend suite follows the remaining storage retirement integration.
### 2026-11-04 — one-time private upload authorization and measured cleanup settlement

The delayed-object regression reproduced an accounting defect in both ordinary
export failure and delivery purge: a client upload timeout was followed by a
successful DELETE of a currently absent key, then the remote PUT completed after
quota had been released. The pinned Storage server can finish after client abort;
its empty deletion response is not evidence that every physical version is gone.
No arbitrary age or timeout is used as a settlement fence.

`20261104170442_durable_storage_write_intents.sql` records one-time send permission
per private key. The current service lease, actor, source and slot reservation are
checked before consuming it. A lost authorization reply or pre-send process crash
remains unknown. Re-entry only reads the same object; it cannot issue another PUT.
Exact positive byte hash/size settles that unique write. Explicit authorized retry
uses a fresh key while the previous uncertain allowance remains in the cleanup
ledger. Ready siblings, immutable content receipts and model unknown usage remain
unchanged. Historical keys without this provenance remain `legacy_unfenced`.

Cleanup now verifies current lease/token/expiry, workspace/key provenance and
active references. An unused permission is atomically closed before its key can be
released, preventing a later begin from reopening it. A completed single write
requires a positive exact-key/nonmarker object-version deletion acknowledgement;
its SQL receipt is bound to the current cleanup lease. Empty, lost, failed or
mismatched deletion evidence retains the existing counted allowance. Unknown
absent uploads defer reconciliation without spending deletion attempts. Unfenced
historical writes and uncertain physical deletion require the separately reviewed
nonce-bound operational quiescence/physical reconciliation, never a boolean or an
elapsed-time assumption. That operational tool and pinned-server binary acceptance
are separate gates, still owned by their integration tasks.

Writer census: server delivery and ordinary export use the new one-time protocol;
`BackendClient.upload` also serves browser document/review/company/manual-export/
restore uploads, and `copyOriginalForOcr` writes private successors. Every untracked
cleanup key from those other paths defaults to conservative legacy provenance.
The single cleanup worker calls the guarded service RPCs; old boolean completion
alone cannot release unknown bytes. Historical already-done cleanup is exposed as
an exact-key physical-inventory candidate, not invented current quota or a claim
that old orphans were repaired. `workspace_status.storage_write_uncertainty` adds
only integer counts and currently held bytes; it exposes no IDs or private paths.

Operational intent and retirement provenance are endpoint-local like cleanup
state, excluded from portable artifact backups. Restore creates new-key legacy
provenance and cannot restore send permission or copy a host's retirement proof.
Purge retains intent identity while transferring existing allowance to cleanup.
The missing-ready-artifact CAS similarly preserves its existing counted bytes
when legacy write settlement is unresolved, without inventing a10MiB charge.

Storage GET/PUT now combine the worker's existing request/lease signal with the
existing20-second transport cap. Cancellation immediately yields the existing
terminal request code while keeping any consumed write permission unknown; it is
not proof the server stopped. Native render/readback verification and all final
SQL authority checks remain in place.

Evidence: the two original delayed-object cases are red→green using real local
commands, worker, DOCX bytes and migrated SQL with a deferred synthetic object
transport. Thirty new scoped cases cover lost PUT/reply, no resend, later positive
readback, fresh-key retry/accounting, pre-send lost ACK, NULL leases, cross-workspace
key collision, user denial, metadata census, restore provenance, legacy missing
artifact accounting, lost DELETE→empty response, unstarted closure, transport
signals, positive/nonmarker deletion receipts and independent replay/current-clock
repros. The140-case related focused run and18-case final replay/storage rerun pass;
backend typecheck/build pass. A broad backend run was stopped at the integration
owner's request to avoid competing with final qualification; it is not a full-suite
pass. The root owns the final exact combined full suites and deployment.

`backend/scripts/testing/storage_write_intent_races.py` provides five actual
PostgreSQL lock-observed cases: one send/audit under duplicate authorization;
unknown deletion refusal/accounting; source edit and actor revocation while
waiting; terminal request winning before send. Its sanitized receipt records the
pinned image, exact migration hashes and scoped runtime source hashes in
[evidence/storage-write-intent-postgres-20261104.json](evidence/storage-write-intent-postgres-20261104.json); all five pass on the final scoped SQL. Storage
server I/O and physical retirement are explicitly outside that database proof.
No production, provider, customer document or email calls were made.
### 2026-11-04 — final renderer representative visual qualification

A frozen checkout at `ddd35b6e721215a891a4f06f2ef0e03798d91e50` generated 18
actual DOCX files from 12 synthetic snapshots with the corrected typed PAGE
footer, streamed tables, lazy native runs and final strict verifier/run budget.
All 18 passed actual strict verification. LibreOffice converted them to 91
pages with zero out-of-page text spans. Every current page PNG hash exactly
matches a previously inspected page: 91 inherited visual inspections, zero
changed pages. The current English and Arabic TOC pages were additionally
inspected at full size. This is exact-image reuse, not 91 new manual inspections.

Fresh XML checks across all documents find no `undefined` elements, proper
direct-run PAGE tokens with neutral highlight, native TOC/PAGEREF instructions,
enabled UpdateFields and empty page-number caches. Every actual PDF footer
contains the correct page number and zero intersecting yellow drawings. The
previous visually matching footer revision had invalid wrappers; its images
are not used as proof of final XML correctness. Immutable source, helper,
engine, font, payload, model, DOCX, PDF and page hashes are recorded in
`evidence/g12-renderer-qualified-{render-receipt,page-receipt,audit,review}-20261104.json`
and summarized in `DELIVERY_VISUAL_QUALIFICATION.md`.

The representative matrix preserves reviewed Arabic/English shaping, tables,
yellow information gaps and volume separation. LibreOffice still omits TOC
page-number results in all 18 conversions; actual Word desktop/web update/save
remains untested. Sparse final pages remain a minor inherited issue. This
qualification neither changes product code nor establishes every dense-layout,
model-semantic, hosted-storage or 600-second issuance outcome. Dense capacity
and worker lifecycle have separate receipts. No full suites, provider calls,
production mutations or deployment were performed in this QA-only change;
root's final combined and deployment gates remain separate.
Follow-up native-byte evidence: the actual API-admitted 69-paragraph alternating
Arabic/Latin model (1.38 million source characters, model SHA-256 `69a027e8…dcd9d`)
now passes this exact strict verifier against the native lazy-run renderer's
actual DOCX. Offline Node with a 128 MiB heap verified 298,013,151 expanded bytes
in 31.763 seconds; the largest inflater callback was 72,809 bytes and measured
maximum RSS was 251,756 KiB. The event loop serviced 1,940 heartbeat ticks, with
maximum observed gap 61 ms. This is verifier-only evidence, not a 128 MiB RSS
claim, full worker Deno/container proof or hosted service capacity guarantee.
Exact input/artifact/helper hashes and measurement details are in
[evidence/docx-direction-run-budget-native-20261104.json](evidence/docx-direction-run-budget-native-20261104.json).
Final renderer/worker resource and visual qualification remain separate.

### 2026-11-04 — independent storage-intent review retains actual red/green evidence

Independent full-migration PGlite cases found two defects before storage-intent
integration: replaying a retry key could expire a later failed upload and enqueue
cleanup, and a lease that expired after transaction start could still grant a
one-time write because the inherited guard used `now()`. The owner corrected
replay ordering after current actor/workspace checks and put a current-clock
lease check in the canonical delivery-job guard for all send/commit consumers.
The exact two independently authored tests pass unchanged against the corrected
migration. These are sequential local SQL tests, not PostgreSQL concurrency,
remote Storage, or production proof. Canonical regressions are retained in
`storageWriteReplay.test.ts`; the independent source, hashes, red/green logs and
scoped review limits are retained in
[evidence/storage-independent-review-20261104.json](evidence/storage-independent-review-20261104.json).

The storage foundation is integrated in `b78ea51`; final private retirement
coordinator, selected Storage binary/quiescence/physical deletion, release guards,
cloud restore and hosted acceptance remain separate gates. A physical-helper
review also found missing directory synchronization after unlink; its author
added awaited directory sync before the absence receipt, with failures refusing
proof. That observation is not a power-failure qualification claim. No production,
provider, payment or external Storage operation ran in this independent review.

### 2026-11-04 — scope G12 against the preexisting Word output contract

The qualification disposition is representative editable draft delivery with
native Word field-refresh acceptance pending. This follows the October 15
`EXPORT_QA.md` instruction to update Word's TOC before external use, the model
execution plan's section 9 and E2E-03 allowance for a recorded TOC limitation,
and W04's explicit target-engine proof or documented remaining review. Exact
references and the unchanged EX-06 integrity/visual obligations are now in
`DELIVERY_VISUAL_QUALIFICATION.md`. Missing LibreOffice TOC page results remain
a measured interoperability limitation; they neither prove Word refresh nor
independently require a new runtime draft-delivery block under that contract.

A fresh read-only tools check found no connected Word session. The Linux
environment had LibreOffice but no Word, Wine or PowerShell executable on PATH.
Actual Word refresh/save acceptance therefore remains unexecuted. Its concrete
next test uses the existing English/Arabic source-bound fixtures, records the
Word version, updates all fields/TOC, checks heading-page correspondence,
inspects pages, saves/reopens and retains content-validation and artifact
evidence. No native Word pass or universal G12 closure is claimed.

This is documentation only. Prior 18-DOCX/91-page evidence is unchanged; no
product code, tests, runtime gates, field caches, deployment or production state
changed. Documentation references and whitespace checks passed. Root's final
combined validation, hosted acceptance and other recorded limits remain
separate.

### 2026-11-04 — fresh original-CA inventory before final release freeze

Read-only [run41881660683](https://github.com/salahassi/tenders/actions/runs/41881660683)
succeeded on `17ba94ba3e6ee13c1227f60b8849c8fe40873564`. Original cluster
certificate/hostname verification and owned temporary SQL-client/credential
cleanup executed successfully; bootstrap, restore and model steps were skipped.
The sanitized receipt is `evidence/digitalocean-inventory-20261104-41881660683.json`;
manifest freezing consumes its inner `receipt` object.

At17:55:32UTC, all ten owned workloads were ready, images and the six release
receipts remained unchanged, and the routine catalog hash remained
`6ba841007e059e1d99b663bb2a68c611768658a0e70f4a2cdf4223d613c27287`.
The delivery tables were still absent: this branch is not deployed. Aggregate
observation included11blocked proposal jobs,91pending background jobs (84due),
and no running or expired-leased jobs in those classes. These counts do not
establish a cause or successful recovery. No business/schema/model changes ran.
Native schedules remained unchanged. This fresh baseline is separate from the
open worker memory, storage-retirement, cloud-restore and hosted acceptance gates.

The managed release authority comparison independently exposed a migration
regression: the new canonical `app_private.app_command` wrapper lost its existing
authenticated EXECUTE grant. Migration170442 now preserves that grant for each
installed role family while its renamed predecessor remains private. Two new
migration-boundary regressions first reproduced the exact ACL loss and then pass
for Supabase and managed `tdp_app_*` roles, comparing the entire canonical ACL,
owner, definer flag and search path before/after, plus no nonowner predecessor
grants. Backend TypeScript build/typecheck passes. This is a scoped local
correction; the integration owner still runs the strict combined managed release
and hosted gates. Runtime/storage settlement behavior and its prior receipts
are unchanged; final release receipts must bind the corrected migration hash.

### 2026-11-04 — require the 22-migration Storage release contract

The release guard now requires the Storage write-intent and private retirement
migrations plus explicit version-1 capabilities. Existing row/column and complete
authority comparisons remain unchanged. The only nonempty new-table exception is
an exact distinct census captured before the batch from existing workspace/key
pairs in delivery artifacts, ordinary slots and cleanup rows, including completed
cleanup. Every new intent must be `legacy_unfenced`, revision 1, with no expected
bytes/hash, send, observation, closure or retirement proof. All other new tables,
including private retirement keys/batches, must initially be empty. Replaying a
completed release preserves later legitimate operational state and history.

Independent catalog checks require the service RPCs, private proof helpers,
restricted table/column access, RLS and registration triggers. They deliberately
do not install or assume authority to install a trigger on managed `storage.objects`.
The release guide now documents this precise exception rather than claiming that
all new tables are empty or that a census certifies physical storage.

Local evidence: four Python cases pass, including the actual full managed-role
PGlite batch/replay and 36 fault variants with complete transaction rollback.
Missing/extra/forged census, unauthorized state/hash/size/timestamps/settlement,
other seeded new tables, RPC/table/column exposure and disabled guards are rejected.
The former all-empty rule was separately reproduced rejecting the valid census.
The same strict test first exposed a canonical `app_private.app_command` ACL loss;
its source owner restored the established authenticated grant in `5a0246b`.
No authority check was relaxed. `py_compile` passes. Exact sources, all 22 migration
hashes, test/log receipts and limits are in
[evidence/storage-release-guards-20261104.json](evidence/storage-release-guards-20261104.json).
The two Storage migrations were borrowed test dependencies and are excluded from
this guard commit. This is not a full package suite, final retirement coordinator,
real hosted Storage, cloud restore, production deployment or semantic acceptance.
## Storage retirement SQL — local proof, operational admission still pending

Migration172700 adds endpoint-local permanent key/family fences and private
Owner-bound prepare/finish functions. Fences have no workspace/artifact foreign
keys and are excluded from tenant backup. Known application namespace aliases
reject before a permanent key is inserted. Preparation and completion recheck
current Owner authority after the workspace lock, exact nonce/key/revision,
active references and the installed fence. Exact lost-ACK replay is retained.
Only a matching single unknown→observed transition can advance once during drain;
other revision/identity drift rejects. Completion atomically marks existing held
cleanup rows done, without charging already-done historical census rows.

The isolated real PostgreSQL suite
`backend/scripts/testing/storage_retirement_postgres.py` passes25 cases against
the exact migration hash recorded in
[evidence/storage-retirement-postgres-20261104.json](evidence/storage-retirement-postgres-20261104.json).
It includes lock-observed Owner demotion, known aliases leaving no fence, future
key/sidecar/ancestor fences, current fence-definition binding, internally
contradictory binary/remaining-byte proof, immutable scope/revision checks,
completion replay, observation during drain, uncertain deletion, no public
assertion privilege and fence survival after cleanup/intent removal. Process and
physical receipts in this SQL suite are explicitly synthetic; this is not a
Kubernetes shutdown or real Storage acceptance result.

No production schema or retirement operation occurred. The trigger is deliberately
not installed on managed storage.objects by the application migration; a separate
reviewed runner must verify actual owner authority and install it. The operational
coordinator, full pinned binary/protocol qualification, resumable-route guard,
checked cloud release and final combined package suites remain separate pending
gates. The discovered signed resumable-upload bypass must be blocked and qualified
before any hosted retirement can release an allowance. Private SQL shape checks
alone do not prove that remote processes stopped or that physical bytes vanished.

### 2026-11-04 — reject direct service column grants in the storage release guard

Independent review found that the new-table guard inspected direct table ACLs
but missed a direct service-role column grant. An isolated managed-role release
accepted `SELECT(storage_key)` granted to `tdp_app_service` on the new intent
table. The same regression now rejects it through `pg_attribute.attacl`, plus
PUBLIC and direct service grants across all three new storage tables. The check
uses only explicit ACL entries; established service inheritance of the application
owner remains valid, and NULL/empty column ACLs are handled without fabricating
owner grants. Original row/authority comparisons and the exact census exception
are unchanged.

One focused Python test passes with six new fault variants and the reused
positive managed release/replay and rollback controls (19.558s on the shared local
host). The pre-fix test failed because the service column grant was accepted.
`py_compile` passes. Exact source/log hashes and retained red/green output are in
[evidence/storage-column-acl-20261104.json](evidence/storage-column-acl-20261104.json).
No full suite, production operation, deployment, binary/protocol qualification
or hosted storage acceptance was performed by this slice.

### 2026-11-04 — exact 22-migration local PostgreSQL restore

The root reran `cloud_restore_postgres.py` after integrating the final retirement
SQL and corrected canonical command ACL. All eight checks pass against all
22 additive migrations: managed catalog capture/reconstruction, row and role
isolation, source/artifact backup, reset failure rollback and trigger state,
fixture identity guards, restored files/history with revoked live assurance,
and idempotent restoration without model usage. Exact source migration hashes
and the pinned PostgreSQL image are retained in
`evidence/cloud-restore-postgres-22-20261104.json`.

This uses real local PostgreSQL with Auth/Storage schema stubs. Actual HTTP
authentication and physical stored bytes remain the isolated cloud drill's gate.
No production, model, email or provider calls ran. Backend typecheck and build
also pass after the 22nd migration integration; the complete backend suite and
remaining operational/gateway changes are still separate pending checks.

### 2026-11-04 — remove quadratic email scanning from content validation

The content-policy email detector now starts only at the beginning of a maximal
local-part character run. Any previously detected address can extend left across
that same character class, so boolean detection is preserved while a long ASCII
word without an at-sign is scanned once instead of at every suffix. The domain
pattern, confidentiality/credential rules, categories and all callers are
unchanged. This adds no product quota or response-size reduction.

A predeclared regression used exactly 1,048,576 bytes of draft-shaped JSON with
100 paragraphs and ASCII runs up to 20,000 characters. The old blockedContent
call used 5,830.970ms process CPU and failed the one-second local test bound. The
new blockedContent and contentPolicyCategories calls used 3.674ms and 3.274ms.
All 89 focused tests passed, including 335,923 exhaustive short boundary strings,
18 explicit Unicode/punctuation controls, permissive legacy email cases, long
prefixes/malformed domains and independent policy-category combinations. The
source and red/green log hashes are in
`evidence/content-policy-email-complexity-20261104.json`.

Backend typecheck passed. Final actual-image provider-envelope/render qualification, combined gates and deployment require the new
source; earlier image timings are not promoted to final evidence. No providers,
production state or billing policy were changed. The unrelated G09 corpus
remains frozen and its uncommitted harness is excluded from this fix.

### 2026-11-04 — Pinned Storage retirement and signed-resumable closure

Implemented the bounded physical census/reconciliation helper and qualified it
against the actual pinned StorageAPI v1.81.0 and Nginx 1.29.5 images, using isolated
PostgreSQL, synthetic bytes and no external network on the fixture containers.
The helper binds exact scopes/manifests, includes actual UUID `.json` TUS metadata
and known `.info` sidecars across both version separators, rejects ambiguous
names/links/changed bytes, and fsyncs deletion directories before issuing absence
proof. Fsync failures and already-absent retry barriers are explicit regressions.
This helper alone never releases quota.

The binary test reproduced a real signed-TUS bypass of the database preflight
through the old gateway (201 creation, 204 write after the key fence). The gateway
now denies the unused resumable protocol on both public/internal ports and rejects
ambiguous first protocol segments. The product caller census confirms ordinary
Storage object APIs; standard upload/download still preserve exact bytes. The
underlying Storage binary remains bypassable if reached directly: the reviewed
ConfigMap, running gateway revision and cluster-only network boundary are mandatory
retirement prerequisites, owned by the separately reviewed release/coordinator
changes. The original red condition is retained in the qualification receipt.

Local verification: **12/12 physical tests**, **15/15 deployment-render/caller
checks**, and **14/14 actual binary lifecycle cases** pass. The latter includes
**38 normalized route cases**, a real 65,536-byte metadata-free orphan after
failed compensation, fixed-root CLI removal with durable directory sync, checked
Storage-owner metadata deletion, normal/signed TUS state cleanup and old-token
replay denial after fresh Storage/gateway processes. Python compilation and diff
checks pass. [The receipt](evidence/storage-retirement-binary-20261104.json) binds
binary/helper/guard/gateway source hashes and contains no credentials/customer data.
[Proof scope and reproduction](../scripts/ops/storage-retirement/PHYSICAL_PROOF.md)
distinguish these checks from coordinator authorization, quota CAS and hosted PVC
or cluster-recovery qualification. Root owns the final integrated package checks.
No production deployment, retirement, provider call or hosted acceptance is claimed.
### 2026-11-04 — bind the qualified storage gateway source to the release

The manifest now requires `storage_gateway_guard_version: 1` and exact
`gateway_configuration` bindings: reviewed baseline and target raw source hashes,
namespace-expanded ConfigMap data hashes, qualification receipt SHA-256, and the
pinned Nginx image from the deployment renderer. Freezing requires that image in
the fresh hosted inventory and strict actual-binary/denial qualification flags
against the target source. Missing or changed source, receipt, image, capability
or manifest fields fail closed. This checker has no gateway or database mutation.

Six lightweight Python methods pass with explicitly synthetic temporary
source-binding fixtures, including absent/symlinked input, unqualified flags,
changed receipts, image mismatch, raw-versus-rendered hashes and manifest drift.
An independent read-only review found no current blocker. The actual independently
produced binary receipt `1831842d…69ff3` and target `b87507bf…731e5` also pass the
source checker with the fresh inner inventory from run 41881660683; all 22
migrations verify in that in-memory candidate. No final manifest was written.
`py_compile` passes. Evidence is retained in
[evidence/gateway-release-binding-20261104.json](evidence/gateway-release-binding-20261104.json).

The baseline source, target source and binary qualification receipt are borrowed
integration dependencies owned by the gateway/retirement changes and are excluded
from this guard commit. No PG/PGlite suite was run after this gateway-only change
during the reserved native qualification window. Final composed operations/SQL
checks, actual checked rollout, physical retirement and hosted acceptance remain
separate gates; unit fixtures do not establish the binary result.

The reviewed gateway baseline is retained in
`backend/scripts/ops/storage-retirement/gateway-before.conf`, SHA-256
`4907ecf81e2fa1e97754202906873ccd7c34e3dcbe26dd1e60cf4e276c639d23`.
This is the expected pre-change configuration, not a claim that the recent
inventory captured live ConfigMap contents. The release must compare actual
ConfigMap bytes and workload identity before its exact guarded update.

### Scoped retirement runner, gateway rollout and recovery controls

The explicit `retire-storage-writes.yml` workflow defaults to service restoration;
retirement and old-process reconciliation require explicit modes and an exact
private encrypted selection. The runner preserves the original cluster CA,
checks actual Storage/function owner authority, pinned binary/helper/guard hashes,
qualified running gateway bytes and cluster-only Storage service/ingress policy.
It refuses known physical namespace collisions before preparing a permanent
fence, then rechecks after all old writers stop. Exact file hashes, inode checks,
directory fsync and checked-owner metadata deletion precede private quota release.

Original Pod identities and real exit receipts are durably retained in Kubernetes.
Unknown live/deleting/missing Pods keep their records; replica restoration does
not manufacture termination. Every workload's exit map is committed before any
of its finalizers is removed, allowing recovery after immediate garbage collection
or lost finalizer ACK. Explicit `reconcile-processes` uses exact UID/resourceVersion
preconditions and normal grace, never force-deletion, and does not release quota.
Independent source review reproduced the prior GC liveness failure and verified
the unchanged reproduction green after this correction. That is synthetic API
control-flow evidence, separately from actual hosted kubelet behavior.

The release now binds and compare-and-set updates only the reviewed gateway
ConfigMap and template checksum, verifies the running file and immutable image,
and preserves the guard after later release ambiguity. The retained baseline is
an expected source value until actual preflight checks it. The same release
preflight rejects Kubernetes worker command/argument overrides and requires an
explicit `APP_RUNTIME_SERVICE=worker`, so an image's measured heap entrypoint
cannot silently be bypassed. It does not change requests, limits or cluster cost.

Local scoped tests pass: 33 retirement/coordinator/adapter cases, 10 exact gateway
rollout cases and 12 release boundary cases. Actual source binding matches the
root's eight-field gateway manifest and binary qualification receipt
`1831842de23dc097269b403987d2530bb486f2fc01c4bde0cb491fd5ae369ff3`.
Python compilation and diff checks pass. The separate physical/binary and 25-case
SQL receipts retain their own limits. No production mutation, maintenance,
provider call or hosted retirement acceptance occurred. Root owns final package
checks, manifest freeze, isolated cloud restore, release and hosted acceptance.
The procedure and recovery/whole-cluster boundaries are documented in
[STORAGE_WRITE_RETIREMENT_RUNBOOK.md](STORAGE_WRITE_RETIREMENT_RUNBOOK.md).

### 2026-11-04 — independently verify retirement recovery after immediate Pod deletion

A separate synthetic Kubernetes API reproduction exposed a recovery dead end:
with two original Pods, cleanup removed the terminal Pod's finalizer before
durable per-UID proof was retained. Immediate garbage collection erased that
identity, and fresh recovery remained blocked even after the other Pod exited.
The corrected coordinator saves exact observed termination receipts in its
Deployment journal before removing finalizers and retains mixed terminal/live
groups. The unchanged independent script then passes: the first record remains
while its peer runs, and fresh recovery completes after the peer exits.

The independent red and green output, unchanged script and reviewed green-source
hashes are retained in
[evidence/storage-retirement-gc-review-20261104.json](evidence/storage-retirement-gc-review-20261104.json).
The pre-fix coordinator source hash was not separately recorded; that limit is
explicit in the receipt. This is a small pure-Python API-state regression, not a
real kubelet termination, PostgreSQL, native-container or hosted retirement test.
No production/provider calls or CPU-heavy suites were run by this review. The
final scoped source review found no additional material blocker after the fix;
checked rollout and hosted physical/process observations remain separate gates.

### 2026-11-04 — expand G09 offline decision-field and retrieval qualification

Frozen, independently reviewed fixture versions now exercise 76 typed-field
pairs across all ten semantic primary tasks plus sixteen explicit nonrecursive
verifier/repair/probe boundary cases. They preserve whole/batch field types,
identity, ownership, disjoint quote scope and unchanged source candidates. Twenty
mutations are deterministically rejected; forty remain visible for later semantic
review; sixteen source-tuple cases are explicitly transport-only. Source tuples
cover actor/negation/conditions/exceptions/consequences, authority/review identity,
and distinct supplier-report versus buyer-account quantities and dates. Existing
exact-source gates and all 43 historical wire hashes are mapped separately.

The independent sixteen-case bilingual retrieval corpus retained every decisive
whole source, and nine bounded fact-plus-qualification excerpts (Arabic queries
4/8, English queries 5/8). All seven missed records remained explicit gaps; no partial
source became claim-eligible and no result asserted capability absence. These
measured misses are preserved without a new outcome-derived recall threshold.
No live model correctness or complete semantic recall is claimed.

The first run's sixteen failures were a missing source_evidence envelope in the
transport harness. Adding an explicit empty catalog corrected that precondition;
it does not fabricate source authority or turn those cases into domain-positive
controls. All frozen fixture versions and first/final outcome hashes are retained.
The focused final run passed 183 tests across five files in 1.47s, including actual
modelPrompt JSON round-trips, source-tuple mutation rejection, scoped repairs and
historical verification pins. Backend typecheck passed.
See G09_OFFLINE_QUALIFICATION.md and evidence/g09-*-20261104.json for the exact
coverage, observed limitations and independently owned provider-capacity gate.

This slice adds tests, synthetic fixtures and evidence only. Root combined gates
and actual-image capacity qualification remain separate; no provider calls,
production mutations, prompt changes, paid-wire migrations or deployment occurred.
Actual configured-provider semantic qualification remains pending while those
providers are unavailable.

The retirement workflow now shares the production deployment concurrency group
`tenderdesk-digitalocean-production`, with cancellation disabled, so deployment
and explicit storage maintenance cannot concurrently change the same workloads.
The physical adapter already writes each scope file once; inspection confirmed
there is no duplicate scope write in the committed helper. Workflow source checks
verify the shared group and cancellation setting. No hosted operation occurred.


### 2026-11-04 — bound repeated private-key marker policy scans

Confirmed a second policy CPU defect in the actual shared content-policy path:
a synthetic 1 MiB line containing repeated `-----BEGIN ` markers without a
`PRIVATE KEY` suffix exceeded a strict three-second isolated Node timeout. The
fresh old-code regression passed 29 controls and failed the bounded subprocess
case. Replaced only that greedy private-key branch with a single-pass literal
marker scan. The same case-insensitive BEGIN-before-PRIVATE-KEY rule and exact
JavaScript dot-excluded line terminators are retained; credential assignment,
email and confidentiality categories retain their existing behavior and order.

All 119 focused tests across three files passed in 1.96s, including 41,371
exhaustive marker/terminator sequences, 27 explicit policy/case/Unicode controls,
the earlier email parity corpus and synthetic provider-policy tests. Actual
1 MiB missing/matching-suffix scans used 2.934–8.361ms of process CPU across all
three policy entrypoints, within the predeclared local one-second CPU bound.
Backend typecheck passed. Source, test, red/green logs and CPU observations are
bound in `evidence/content-policy-credential-complexity-20261104.json`.

No provider calls, production changes, paid-wire changes or production budget
changes occurred. Root's combined gates, rebuilt actual-image resource proof
and deployment remain separate; a local policy timing pass is not a render
memory/deadline qualification.

### 2026-11-04 — align the commercial diagnostic assertion with indexed correction paths

The detached c9f1c5b combined backend run passed 2,889 tests and failed two.
The owned commercial-scope failure was a stale test expectation: it expected
`$.lines`, while the existing collector returned the exact invalid reference
`$.lines[0].section_ids[0]`. The candidate remained schema-valid and the rejection
code/reason remained `EVIDENCE_REFERENCE_INVALID` / `invalid_finding_reference`.
Only the expected test path changed; schema, runtime validators and evidence
gates were not modified.

The two focused files passed all 24 tests in 1.04s, including the existing
300-error commercial collector/explicit-overflow checks. Backend typecheck
passed. The combined red log and focused green/typecheck hashes are recorded
in `evidence/commercial-diagnostic-contract-20261104.json`. The other database
constraint-name expectation and final combined run are separately owned; this
focused result does not establish a full-suite pass. No provider calls,
production mutations or deployment occurred.

### 2026-11-04 — Combined-suite queue constraint regression

The combined backend run at `c9f1c5b` exposed a stale test expectation:
`database.test.ts` still named the former blanket one-active-job index. Migration
`20261104163406_serialize_local_document_rendering.sql` deliberately retains the
hard non-render lane for `draft_section` under
`one_active_non_render_job_per_workspace` and adds a separate globally serialized
render lane. The test now identifies its non-render scope and requires both
SQLSTATE `23505` and that exact constraint. Duplicate active work must still fail,
leave attempts at zero, record the heartbeat and allow the pending claim only
after the first lease finishes. No production SQL or scheduling guard changed.

Local verification: `database.test.ts` and `documentRenderAdmission.test.ts` pass
**32/32 across two files** with `--maxWorkers=1` (6.43 seconds). The latter retains
positive coverage for independent render/non-render admission and unchanged model
reservation capacity. This resolves the confirmed index-name assertion only;
root owns the remaining combined-suite failure and final integrated rerun. No
provider calls, deployment or production mutations occurred.

### November 4 — isolate the cloud restore Auth RLS prerequisite

Cloud drill `41902822255` failed at `cloud_restore_fixture_users`; original TLS,
offline guards and both cleanup steps passed. The pinned Auth v2.197.0 migration
[`20240612123726_enable_rls_update_grants.up.sql`](https://github.com/supabase/auth/blob/v2.197.0/migrations/20240612123726_enable_rls_update_grants.up.sql)
enables row-level security on `auth.users` and `auth.identities`. The disposable
application owner had SELECT grants but no applicable read policy. Previous local
Auth stubs did not enable that RLS and therefore missed this integration boundary.

A tiny real PostgreSQL regression now reproduces the exact fixture rejection,
then passes the unchanged fixture and canonical workspace bootstrap after adding
SELECT-only policies for the nonce-bound application owner. Policy creation runs
as the actual Auth table owner, checks both RLS flags and ownership, and requires
the exact disposable database/comment. Browser denial, Auth write denial, other
Auth table denial and NOBYPASS roles remain verified. This is an explicit isolated
harness prerequisite; it is not a claim that production has the same read policy.
The production catalog capture excludes Auth policies, and repository setup alone
does not establish current production Auth visibility. The next read-only capture
reports only owner/RLS flags, effective application-owner SELECT/inheritance and
applicable SELECT-policy counts/commands; conditional predicates remain unproved.
No user rows, predicate text, SQL, secrets or production permissions are changed.

RPC errors now retain HTTP status and a fixed allowlist of SQLSTATE/PostgREST
classes while discarding response messages/details/hints. The synthetic artifact
also obtains its one-time send permission before PUT, verifies readback before
completion, and refuses a replayed send; this is not whole-worker qualification.
Twelve offline helper
tests and five real PostgreSQL checks pass; the latter use Auth table stubs with
the actual pinned RLS behavior, not live Auth HTTP. The narrow regression cleans
its exact temporary database and roles. The 22 frozen application migrations are
unchanged. Hosted restore retry and actual production Auth metadata verification
remain separate pending gates; no hosted call occurred in this correction.

### 2026-11-04 — Isolated cloud restore bucket contract correction

Cloud restore run `41905235686` advanced past synthetic Auth identities and source
reviews, then stopped at private bucket creation. The disposable bootstrap Storage
has a 1 MiB global object limit, while the restore fixture requested a 10 MiB
bucket. Actual pinned Storage v1.81.0 with isolated PostgreSQL reproduced HTTP 400
`EntityTooLarge` and confirmed that no bucket was created; this was not an
already-existing bucket condition. The restore fixture now requests 1 MiB for its
tiny synthetic DOCX. It requires successful creation and a separate exact
id/name/private/size-limit metadata readback, rejects existing buckets, and emits
only HTTP status plus an allowlisted error class. It never prints private Storage
messages, details or identifiers.

Six new focused tests and the existing twelve restore helper tests pass. The
opt-in pinned binary probe executes the actual composed acceptance class: matching
limit creation, metadata readback, exact upload/download bytes, unauthenticated
public-path denial and duplicate rejection pass, and its own containers are
removed. The sanitized receipt is
`backend/docs/evidence/cloud-restore-bucket-20261104.json`; the reproducible command
is `python3 backend/scripts/testing/cloud_restore_bucket_container.py --output /tmp/cloud-restore-bucket-proof`.
This is isolated local HTTP evidence for a tiny fixture, not qualification of the
product's 10 MiB file limit, whole application rendering, production Auth policy,
or a successful hosted restore. No application migration, production configuration
or hosted service was changed. The next reviewed hosted restore retry remains a
separate gate.


### 2026-11-04 — respect explicit managed SET ROLE authority in retirement

Real non-superuser PostgreSQL qualification reproduced the retirement adapter's
incorrect inherited-privilege assumption. Managed setup grants INHERIT FALSE,
SET TRUE: `pg_has_role(..., 'USAGE')` rejects that legitimate administrator,
while an inherited-only caller can pass USAGE without permission to SET ROLE.
The adapter now checks SET authority. Exact object owners and the installed
function fingerprint are resolved through catalogs before role changes, avoiding
schema-qualified casts that themselves require the deliberately absent inherited
schema USAGE. Fence installation retains its exact owner/function/trigger checks
and revokes only the temporary execution grant it added.

The same authority correction covers census, multipart and metadata readbacks.
Storage reads/deletion run as the actual authorized Storage owner; the complete
collision census switches to the application owner in the same repeatable-read
transaction. It does not grant schemas to the administrator or broaden roles.

All 41 focused tests passed in 9.740s: eight actual PostgreSQL 17.6 authority cases
and 33 existing adapter/coordinator controls. Tests cover SET versus inheritance,
real role transitions, fence replay, unchanged schema/function ACL and membership,
complete cross-owner census, missing SET refusal, multipart detection and exact
quoted-key deletion with unrelated rows preserved. A prior expanded attempt
stopped before PostgreSQL execution because Docker had no disk space; its log is
retained separately. The final disposable network-none container was removed.
Evidence and red/green hashes are in
`evidence/storage-retirement-owner-authority-20261104.json`.

No production, external service, file deletion or quota-release operation ran.
PostgreSQL 18 on the managed deployment remains an explicit guarded-release
check; this local execution is PostgreSQL 17.6. Pinned Storage binary behavior,
Kubernetes quiescence and hosted retirement acceptance retain their separate
qualification requirements.


### 2026-11-04 — isolate canonical DOCX verification; final resource gates pending

Real steady-worker testing reproduced a cgroup OOM on the second large
two-volume job despite a successful first job and a temporary worker-only
256 MiB parent old-space experiment. The failed receipts are retained in
`evidence/native-verifier-parent-default-red-20261104.json` and
`evidence/native-verifier-parent256-steady-red-20261104.json`. The temporary
parent entrypoint/heap override is removed; original pinned image startup and
parent resources remain unchanged.

Every runtime asynchronous canonical verifier now uses a fixed offline Deno
child and the same physical FIFO permit as native rendering. The bounded binary
input requires exact lengths and EOF; a successful child exit must return the
exact model SHA256, DOCX SHA256 and size. Strict bounded verdicts, canonical
content error codes, cancellation/deadline kill-and-reap, private within-run
readback proofs and existing authority/currentness checks remain intact. Child
infrastructure failures retain the existing bounded-retry renderer codes; Deno
has no fallback to parent-process verification. The child budget is selected
only from deployment-owned `APP_RUNTIME_SERVICE`: worker 128 MiB old-space;
API/other/default 64 MiB. A private frame buffer no longer receives a redundant
full-size hashing copy; shared backing buffers are copied defensively. Docker
now includes the native streaming renderer dependency and caches both fixed
child entrypoints. No storage/model quota, SQL schema, parent resource limit,
prompt hash or published artifact is changed.

The 83-case canonical verifier/worker/process scope passed. After adding trusted
service selection and exact byte-view/shared-buffer hashing checks, all 34
process/protocol tests and backend typecheck passed. Root owns final combined
package gates; these checks are not a hosted acceptance claim.

The 128 MiB child image completed two consecutive dense two-volume jobs in the
same worker parent in 109.384s/108.943s, with fixed 180s leases / 600s request clocks,
no forced GC/restart and concurrent real parsing/validation of exact 1 MiB and
50,000-cell synthetic provider envelopes. Peak cgroup memory was 579.58/640 MiB;
each job completed two PUTs/four GETs and both volumes. The expiry case wrote
nothing and subsequent health returned 200. SQL/Storage were explicitly emulated;
see `evidence/native-verifier-worker 128-steady-20261104.json`. Four default image
service startups passed without the parent heap override.

API 384 MiB with 128 MiB child hit a cgroup OOM and safely rejected the result;
`evidence/native-verifier-api128-red-20261104.json` preserves it. The 64 MiB child
candidate passed seven actual admitted fixture families twice each plus five
canonical rejection/real CPU cancellation/recovery checks in the same API-sized
parent. This was 1 CPU, not the declarative 700m API limit. Peak cgroup memory
383.94/384 MiB does not establish margin or burst safety. The giant verifications
took 71.9s/70.5s, so worker 128 is retained. See
`evidence/native-verifier-api64-candidate-20261104.json`.

Still pending: final service-specific image proof, API 700m / gateway 150s timing,
near 10 MiB canonical-model / 8 MiB saved-payload shapes and 4 MiB reviewed metadata,
anonymous/file memory telemetry, and early heavy-file API admission with slow
consumer/burst tests. The native permit alone does not bound API inputs allocated
before admission. The current sequential receipts do not qualify arbitrary
concurrency, real authenticated HTTP/hosted Storage, or production SLOs. No
provider, billing or production mutation occurred in this slice.

### November 4 — repair the observed production Auth read boundary

Hosted restore run `41905235686` observed `tdp_app_owner` with SELECT on both Auth
identity tables, no superuser/BYPASS privilege, no inherited Auth ownership, RLS
enabled, and no applicable read policy. This confirms a production permission
gap, distinct from the isolated fixture failure. Later drill `41908346634` passed
13/13 real Auth/Storage restore checks with cleanup using the temporary harness
policy; it does not qualify the shared platform repair below.

The reviewed `application-auth-read.sql` platform helper creates only the two
SELECT policies for the existing application owner. It assumes the actual Auth
owner through explicit SET authority; verifies exact database marker, ownership,
RLS, intended SELECT, browser denial and safe role attributes; rejects unknown
applicable policies and drifted canonical policies; and preserves table/column
ACLs, ownership, roles, memberships and unrelated policies. It performs no Auth
row writes or grants and does not disable RLS or add BYPASS privileges.

The release manifest now binds the helper and renderer hashes with capability
`application_auth_read_version:1`. The policy work shares the same transaction
as the 22 application migrations and release ledger, before the receipt/COMMIT.
Auth relation locks have bounded waits and precede the first repeatable-read
query snapshot. A real two-session PostgreSQL regression reproduced the late-lock
failure (a hidden concurrent policy changed owner visibility from zero to two
synthetic rows) and verified early-lock rejection after an observed lock wait.
No extra advisory lock introduces an inverted lock order. Exact replay preserves
policy OIDs; an Auth-policy conflict after all application DDL rolls back new
schema, ledger and policies while preserving old rows and the conflicting policy.

Future managed schema provisioning and isolated restore use the same helper; the
independent harness policy was removed. Local evidence: 11 real PostgreSQL cases,
12 helper tests, 9 release tests plus one targeted complete-batch rollback case,
and two managed schema reconstruction tests pass. The release suite retained
the existing row, authority, column-ACL and legacy-seed fault cases. Tests used
the root's already-installed dependency tree through a temporary local symlink;
the symlink was removed after verification. The legacy full-catalog fixture was
updated for actual Auth RLS/marker prerequisites but was not separately rerun.
No model/provider or production mutation occurred. All 22 canonical migration
files remain unchanged. Root must refreeze the manifest for the new platform
hashes, run a fresh managed cloud drill with this helper, then execute the reviewed
release and verify actual production Auth policies. Those hosted gates remain open.

The integrated manifest was subsequently refrozen from the same original
inventory receipt. Canonical manifest SHA-256 is now
`9e3430d1d01af222e3aad0d4aa8cae5e1f0c14942ae0ff258f0a96f6f953e020`;
only the shared Auth helper contract and capability were added. All 22 migration
hashes, gateway qualification and original deployment baseline remain identical.
Source verification passes. The next isolated cloud drill must use this manifest
and the shared helper; the preceding thirteen-check success is retained at its
older source and does not substitute for that drill.

### November 4 — verify the API runtime envelope before release

The release preflight now checks the actual API container as well as the worker:
at least 384 MiB memory and 700 millicores, no Kubernetes command/argument override,
and exactly one explicit `APP_RUNTIME_SERVICE=api` environment entry. Missing,
malformed or smaller limits and ambiguous roles fail before the SQL client,
gateway patch or any workload mutation. The quantity parser is shared with the
existing worker guard; its 640 MiB/one-core requirements and error codes remain
unchanged. No resource requests, limits, replicas or billing settings are changed.

The sanitized release receipt includes observed API limits, requests, replicas
and minimum requirements, with `hosted_load_qualified:false`. This records the
deployment boundary; actual image/native-capacity and hosted-load qualification
remain separate gates. All 15 release-boundary tests pass, including API size,
entrypoint/role rejection, stronger equivalent quantities, unchanged resources
and receipt checks. Python compilation and diff checks pass. No model or hosted
operation occurred; the frozen manifest and canonical migrations are unchanged.


### November 4 — independent remaining-action handoff draft

Prepared a document-only audit anchored to integrated `41930bb`, updated through
`fa3958e`, with nine current remaining actions and a twelve-group public R0
evidence index. Every indexed public receipt hash was checked against the
coordinator checkout. This is an index and scoped status reconciliation, not
a certificate that every per-case R0 field is complete.

The draft retains the 2,889-pass/two-failure backend run and its focused assertion
corrections, both failed hosted restore drills, the confirmed production Auth
row-visibility prerequisite, reported private-bucket/global-size mismatch,
retirement SET-role preflight investigation, and the latest reported worker-pass/
API-memory-failure split. Pending agent results are explicitly distinguished from
ingested public receipts. The 22-migration/gateway manifest is already frozen;
application deployment and hosted issuance acceptance remain open.

Files: `RELIABILITY_REMAINING_GATES.md`,
`evidence/reliability-remaining-actions-20261104.json`, and
`evidence/reliability-r0-index-20261104.json`. No implementation, fixture,
dependency, database, provider or deployment changes were made. No project tests
were run during the native qualification window. Final runtime/Auth fixes and
new actual results must update this draft before the final handoff.


### November 4 — remaining-action audit revision 2 after shared cloud restore

Updated the document-only handoff through `a667686` to eight current remaining
actions. Shared-helper hosted restore 41910306855 passed all 13 Auth/Storage
checks with original CA, 12 offline guards and cleanup; this closes the isolated
restore scope, not production policy application, application runtime or hosted
proposal issuance. The 22-migration manifest now binds the shared Auth helper
(`9e3430d1…953e020`). Local actual PostgreSQL Auth concurrency and retirement
SET-role authority receipts are indexed with their independent limits.

Native verifier isolation is integrated. Worker two-job/two-volume proof and
the nearly full 384 MiB direct-verifier 64 MiB child candidate are retained, alongside
the earlier failures. API working-set admission, full-content paging/client
sequencing, valid large-batch streaming and final actual-image proof remain open.
Every newly indexed receipt hash was checked. No source edits, project tests,
provider calls or production mutations were performed by this audit. The final
combined application checks and deployment/hosted acceptance are still required.

### November 4 — stream complete command batch results through the API

Implementation: the dedicated `batchTransport.ts` module sends the same single
authenticated PostgREST `app_batch` request with the caller JWT, publishable key,
public schema and unchanged ordered commands/idempotency key. Successful JSON
bytes stream into the existing `{data,meta:{request_id}}` envelope without a
result parse/stringify copy, command splitting, response quota or SQL change.
Both stream layers use zero-prefetch backpressure. Request abort and downstream
cancellation stop the upstream fetch; terminal errors wait for source cancellation
to settle so a surrounding admission permit can retain ownership through cleanup.
Redirects and ambiguous configured URLs are rejected. Existing database and
platform timeouts remain; the previous batch SDK call set no client timeout.

Only error diagnostics are bounded to 64 KiB. Valid PostgREST errors retain the
existing `databaseError` mapping, including proven transaction-aborting SQLSTATEs.
Transport/protocol failures have sanitized, non-retryable errors because commit
state may be unknown. A partial response fails without appending success metadata.
The transport does not automatically replay any request.

Local evidence: 29 focused synthetic transport tests pass, including exact JSON
and split UTF-8, CORS/request metadata, caller authority and URL construction,
observed upstream pull counts during a paused consumer, an 8 MiB streamed hash,
bounded diagnostics, abort before/after headers, delayed source cancellation and
partial body failure. A targeted strict TypeScript check of the module/tests passes.
These fixtures exercise API transport only; they do not qualify database response
buffering, native renderer capacity, a real authenticated HTTP connection or hosted
load. Backend/handler and admission integration is a separate owned change; full
repository checks and final integrated native/runtime qualification remain open.
No external, provider, accounting, SQL or production operation occurred.

The follow-up transport guard now requires the first and last non-whitespace
bytes to be `[` and `]`, accepting only JSON's four whitespace bytes at those
boundaries. Scalars, objects, blank bodies and visibly truncated arrays fail the
stream before success metadata is appended. This uses constant state, preserves
raw UTF-8 and adds no size limit; it does not validate internal JSON syntax, which
remains the configured PostgREST JSONB serializer's contract. All 42 focused tests
and the targeted strict TypeScript check pass, including chunk-boundary and
negative controls plus the previous backpressure/cancellation regression cases.
Upstream SQL/PostgREST memory qualification and integrated native/hosted evidence
remain open.

### November 4 — preserve the scoped operational suite results and source drift

At root revision `a6676866ea3247b85c1bfde7e140655ce126e444`, the canonical
Python suites ran sequentially: 414 operational tests, 11 managed-schema tests,
and 15 Kubernetes tests passed (440 total). The run started at 20:56:22 UTC and
finished at 20:59:10 UTC. The public scoped receipt is
[`ops-schema-kubernetes-scoped-20261104.json`](evidence/ops-schema-kubernetes-scoped-20261104.json);
it binds the commands, counts, log hashes, observed revision and source hashes.
Raw logs and the original receipt remain outside the repository.

The 702-file before/after check detected a change to
`deliveryVerifyIsolation.ts` during the run. The operational, schema and
Kubernetes inputs in the recorded scopes remained unchanged, but the broad
source identity gate failed as intended. The original receipt retains
`passed:false`; the public receipt records passing suites separately from
`combined_final_source_qualified:false`. The two acceptance scripts indirectly
import this verifier through `export.ts`; their discovered Python tests mock
the child process and external transports and therefore do not qualify the
changed verifier. Existing native capacity harness edits are also disclosed.

This is scoped local evidence, including PostgreSQL 17.6 fixture execution;
it is not a final combined integration pass, package-suite result, native
capacity result, production PostgreSQL qualification or hosted acceptance.
There were no hosted or model calls. No immediate rerun was started during the
reserved native capacity window. The final committed integration must rerun
these canonical suites alongside the separately owned package and native gates.


### 2026-11-04 — release private verification frames after complete transfer

The verifier drops its private serialized JSON after encoding, and drops its
private encoded-model/DOCX references only after all stdin writes and close
complete. Expected SHA256/size values remain unchanged, no backing bytes are
mutated, and cancellation still kills/reaps before releasing admission. Two
independent reviews found no proof downgrade. All 34 identity, process, role,
byte-view, timeout and cancellation tests plus backend typecheck pass. This
reduces retained input data; it does not itself establish a memory bound for
caller contexts, Storage Blobs or pending responses.

`evidence/native-verifier-protocol-render-20261104.json` records real bounded
rendering of three synthetic protocol/storage-shape probes: two models at
10 MiB minus 1 KiB, and 600,000 empty rows across 12,000 tables. All DOCX files
were below 10 MiB and rendered within the unchanged 30-second attempt budget.
These models were not admitted through an application API; the empty-row
saved-v1 payload has only a conservative JSONB-size argument, not a database
admission receipt.

An initial API-sized component probe retained redundant measurement-only
model/byte hash allocations and hit a cgroup OOM; its confounded red receipt is
retained. Those allocations were removed; immutable staged input hashes remain
bound externally. The corrected 384 MiB / 700m run accepted the corrected native
base, exact 4 MiB core.xml, near-10-MiB ASCII model, and combined ASCII/core.xml.
The near-10-MiB single mixed-script paragraph then returned an infrastructure
error while the parent survived and Docker reported no cgroup OOM. Child cause
was not established because runtime stderr is intentionally suppressed. See
`evidence/native-verifier-protocol-700m-diagnostic-20261104.json`.

That direct protocol-only paragraph is not a demonstrated current producer
case: document blocks have a 12,000-character SQL bound; notice fields compose
at most 103,003 characters; current writer paragraphs have a 20,000-character
bound. The diagnostic remains unresolved robustness evidence, not proof that
an admitted application proposal fails. No source/input or child-budget policy
was changed in response. Actual authenticated-handler projection, early file
admission, streamed command responses, slow consumers and final resource/image
qualification remain separate pending gates; synthetic Auth/Storage transport
must be labelled when used. No production or provider call occurred.


### 2026-11-04 — admit heavy API work before context and file allocation

The actual handler regression reproduced three concurrent artifact-context and
Storage reads while the first saved export remained pending. A per-handler
single permit now admits authenticated, current members before large context,
file, record, request-body and model projections. Excess work receives immediate
503 `FILE_PROCESSING_BUSY` with `retryable:true`; there is no waiter queue, new
time allowance or model/billing quota. The runtime creates one API handler;
this is not a cluster-wide concurrency claim.

The permit survives successful handler return and remains held through actual
response EOF or cancellation settlement. It does not prefetch the response body.
Aborted uncooperative work cannot free admission while still running, nor later
serialize its result or authorize a download. Existing final file-currentness
RPCs remain immediately before the download response. Caller cancellation now
reaches Storage reads; legacy object reads use the existing 20-second Storage
transport bound. Errors release admission without marking a busy artifact lost.

The pure shared classifier covers explicit file/context/authoring/recovery routes
and 24 full-content record resources. Complete records use one row per page with
no lookahead; a final empty page ends traversal. No business fields or aggregate
records are discarded. Internal model-settings/connections metadata readers and
compact generation-plan/restore-session lists retain their bounds. Shared browser
sequencing and whole-load identity pinning are separately owned compatibility
changes that must ship with this API policy. Health/status/bootstrap/issuance and
notifications remain independent of large downloads.

The handler integrates the separately reviewed raw app_batch transport from
0e93144 with the 90353bb array-shape follow-up, without materializing the
potentially large result array. It preserves
caller authorization, validated command order, idempotency and the existing
JSON data/meta envelope. Composed cancellation tests hold API admission until
upstream cancellation settles.

All 114 focused tests across seven files passed in 4.31s after the batch
shape follow-up; backend typecheck
passed. An additional 31 tests across the three canonical migrated database,
HTTP and delivery pipeline files passed in 13.43s. Existing tests that reused a
handler now drain their successful response before the next heavy request;
forged-input/currentness/schema rejection checks remain. Source/log hashes,
red reproduction, lifecycle coverage and limitations are recorded in
`evidence/api-heavy-file-admission-20261104.json`.

No native OOM/throughput or hosted release claim follows from these local tests.
Actual-image simultaneous file/large-record/batch response, network backpressure,
client disconnect and NGINX behavior remain the final resource qualification.
No provider calls, production mutations, SQL migrations or billing changes ran.

### 2026-11-04 — Browser sequencing for heavy API content admission

The connected browser now uses the same pure heavy-request classifier as the API
and holds one FIFO lane per `BackendClient` through complete JSON or Blob
consumption. Existing concurrent panel reads and technical/financial downloads
therefore serialize their own heavy sends; lightweight bootstrap/status remain
available. Commands keep their body and idempotency key, are never automatically
retried, and bind the identity observed before queueing. A queued request refuses
a different signed-in identity before sending; a refreshed token for the same
user remains supported. Abort, HTTP error and malformed JSON release the lane.
An external `FILE_PROCESSING_BUSY` remains the server's visible error and requires
an explicit user retry; this browser queue is not server authorization or a
cross-browser lock.

Repository loads now serialize all sixteen required table/page chains, suppress
superseded queued loads, and stop superseded pagination before another page.
Every full-content record and continuation is retained, including the server's
new final empty page. The separate generic client list's undocumented aggregate
10,000-row guard was removed: with no lookahead it rejected even exactly 10,000
records before the final empty page. This changes no server/product capacity
limit, and matches the already-tested unlimited required-record startup policy.
Duplicate records, repeated/backward cursors and nonempty continuations without
records still fail closed. Model activity retains its separate descending decimal
sequence contract, compared losslessly with BigInt rather than UUID ordering.

Against base `28689b9`, the focused regression reproduced sixteen overlapping
load requests and failure at the old aggregate guard. Eighteen focused pure tests
now pass, including 10,001 full one-record pages, stale-load suppression, queued
identity switch, token refresh, abort/error release, preserved command key/body,
and artifact-byte sequencing. Frontend typecheck passes. The shared classifier
is supplied by the companion API commit; it is not duplicated in this browser
commit. Full integrated frontend/backend/native and hosted checks remain
separate; no provider calls, production writes or dependency changes occurred.

A subsequent independent review found that per-send identity binding alone could
still mix users across a multi-page logical read. The follow-up captures identity
at the start of the complete list/load, carries it across every page and table,
and rechecks before publishing the result. An account switch rejects continuation
before another user's fetch; it also rejects a changed identity after the final
page. Four actual-client regressions fail against `d4fb950` and pass with the
follow-up. The focused pure suite now passes 22 tests, and frontend typecheck
passes. Existing connected-file fixtures explicitly supply their synthetic Auth
identity. The guard is client-side stale-result prevention, not a replacement for
server authorization; full integrated and hosted verification remain separate.

### 2026-11-04 — Actual API download working-set qualification

The capacity fixture now optionally exports its actual persisted v2 snapshot
beside the exact render projection. The selected migrated authoring API case
passed with 4,143 tables / 2,112,930 normalized cells; the next full table still
fails the existing JSONB bound before mutation. The selected run passed one test
and intentionally skipped nineteen; its full-suite receipt flag is therefore
false, not evidence that twenty tests ran.

The immutable application image `a3b88b89b6a4afe5861f04d36fcae748c7e104355c3d37fab7a26e45e49c2a2e`
rendered that exact snapshot projection and served two actual `createApiHandler`
delivery downloads in the same parent at 384 MiB / 700m CPU. Auth/RPC authority
and Storage transport were synthetic adapters; the handler, model projection,
Blob lifetime, canonical verifier subprocess, final actor/hash check, response
copy and admission wrapper were actual application code. Both 8,166,765-byte
responses matched the immutable DOCX SHA256. Headers arrived in 109.518s and
107.791s, and full local consumption took 110.525s and 108.798s. No forced GC or
parent restart occurred. Concurrent heavy requests failed with retryable busy
before context/Storage allocation, and 437 health requests completed.

Peak cgroup usage was 400,809,984 / 402,653,184 bytes (1.76 MiB remaining), with no
max/oom/oom_kill events and separately observed zero swap current/peak. This is a
narrow measured margin, not proof of arbitrary workload headroom. Native request
timing is not an actual NGINX or upstream PostgREST qualification.

Independent harness review caught a mislabeled post-consumption control: the
historical run used lightweight `/v1/proposals`, so its
`subsequent_heavy_read_status` does not prove final cancellation releases the
heavy permit. That claim is explicitly excluded in
`evidence/native-api-handler-scope-adjudication-20261104.json`. Second-request
admission does prove release after the first EOF. The harness now uses the
classified heavy `/v1/documents` route; its separate cancellation proof, three
current-policy ordinary export projections from the body-bound fixtures, and
final integrated image/release acceptance remain pending. Original raw receipts
are retained unchanged. Backend typecheck passed; no provider or production
calls, resource changes, or payload-cap changes occurred.

The next native repeat failed before the corrected cancellation control: the
same image/input at 384 MiB / 700m returned `DELIVERY_RENDER_FAILED` after about
103s, and Docker recorded OOMKilled. The prior 1.76 MiB margin was therefore not
stable capacity; the API release gate remains open. This red receipt is retained
as `evidence/native-api-repeat-oom-20261104.json`. No heap or resource increase
has been applied.

The resulting lifetime fix eliminates the delivery byte path's duplicated
model-object parse/stringify, snapshots model JSON before an asynchronous Blob
read, and hashes already-private bytes without an additional explicit copy.
Only the internal owned-snapshot bridge avoids the copy; the generic verifier
still snapshots caller bytes/model before yielding. Child frame hashes are now
computed before inflater allocation churn, and the raw model frame is released
after parsing. Full canonical validation, exact hashes/size, successful child
exit, abort/deadline/reap and private within-run proof binding remain required.
All 47 focused tests across four files and backend typecheck pass, including
model mutation during delayed Blob reading, byte mutation, forged/stale proof,
generic call-time snapshots, abort/timeout and shared native-process admission.
Independent source review found no material ownership/hash regression. Actual
native repeat measurements of this fix are still pending.

Separately, all three ordinary projections from the persisted section-body
fixtures now render and verify with the current worker's placeholder policy2:
generated100 tables (3.064s), authored100 tables (2.903s), and69 mixed-script
paragraphs (21.008s). Source requests and frozen legacy projections are both
hash-bound; the current policy is applied explicitly. At 640 MiB /1CPU the peak
was406,900,736 bytes, no OOM events, swap0. The large ordinary DOCX is3,177,596
compressed bytes and298,012,602 expanded bytes. This proves content/renderability
of those saved projections, not approval or semantic completeness. It also
provides the exact file for the separately owned reviewed-upload40MiB original
archive-limit red/green test. Receipt:
`evidence/native-ordinary-body-20261104.json`.

The lifetime fix now has actual native repeat evidence on immutable image
`89afc8a31d76e1616ad17e5896e0fc54f0acdc41cd7da389af456386f3e998fe`:
two largest admitted downloads in one parent, followed by one separately launched
fresh-parent repeat matching the prior failing sequence. At unchanged 384 MiB /
700m, headers arrived in112.208s,107.866s and104.811s; exact complete responses
took113.216s,108.872s and105.818s. Final actor/hash authorization, slow-consumer
busy rejection before full context/Storage, and genuinely heavy `/v1/documents`
reacquisition after EOF and cancellation passed. No forced GC, heap override or
resource increase occurred. Cgroup peaks were387,506,176 and391,241,728 bytes,
with no max/oom/oom_kill events and swap peak0. Minimum observed headroom is
10.88 MiB: the local fixture gate passes, but arbitrary workload headroom or a
universal SLO is not claimed. Original red receipts remain unchanged.

The same image also passes the actual reviewed-DOCX completion handler using
the exact ordinary artifact from the earlier rejection, its saved request and
an explicitly synthetic server-owned `ordinary-2` pin. Canonical verification
completed before the single actor/hash/size-bound completion call: HTTP200 in
30.996s, peak367,247,360 bytes at384 MiB /700m, no OOM or swap. This closes the
same-file native content/working-set gate for the separately implemented upload
envelope fix; it does not create or qualify a real workspace approval. Receipts:
`evidence/native-api-owned-snapshot-steady-20261104.json`,
`evidence/native-api-owned-snapshot-fresh-20261104.json` and
`evidence/native-reviewed-docx-handler-20261104.json`. Auth/RPC/Storage remain
labelled synthetic adapters, and actual upstream, gateway, hosted authorization,
full integrated package checks and deployment acceptance remain separate.

### 2026-11-04 — Additive read-only capacity inventory preparation

The inventory now adds `capacity_observation` without changing its existing
workload/schema fields or frozen release baseline. It separates observed
API/worker/REST deployment resources from ready Pod specs, preserves missing
limits as unknown, and projects only fixed runtime roles and REST pool/max-row
configuration. The optional observer helper reuses the existing managed database
metadata request and already-read core Secret; private URI/host/password values
never enter the receipt. Managed size and node count are retained, while RAM/vCPU
remain unknown because the metadata does not establish them independently.

A separate read-only SQL query preserves the observer login's three capacity
settings before applying its own bounded query timeout and lists exact
current-database/application-role catalog defaults. It explicitly does not claim
these are effective authenticated REST transaction settings. The diagnostic is
manifest/catalog evidence, not cgroup, throughput, production capacity or load
qualification. No hosted call, dispatch, production write, migration or provider
request occurred. Focused local verification and the next reviewed runner
inventory are recorded separately; the code alone does not fill the missing
hosted resource evidence.

Local verification passes 35 focused tests in 2.26 seconds, Python compilation
and diff checks. Two cases execute PostgreSQL through isolated in-memory PGlite:
the new query retains a 700 ms original timeout separately from its 20-second
query override, retains a 6 MiB observer work_mem separately from an 8 MiB
role/database default, and rolls back its settings; the existing observer query
also remains green. Other cases cover credential-free projection, exact private
URI/original-CA binding, missing resources, distinct deployment/ready-Pod limits,
DO metadata-fetch reuse, unchanged old receipt fields and verified cleanup.
These are local correctness tests, not a hosted SQL/session or capacity result.
Root source review found no material blocker before integration. Fresh hosted
inventory remains pending the reviewed Actions dispatch.

### November 4 — preserve accepted structured sections beyond the legacy text ceiling

Independent SQL reproduction at `f80858f` confirmed that actual `nextStage` →
`advance_generation` rejects a schema-accepted 100-table/50,000-cell section at
`proposal_sections_body_check`. A 69 × 20,000-character mixed Arabic/Latin
response was accepted by the actual authoring save and substantive-review API,
then adoption failed at persistence. No live model or customer content was used.

New CLI-created migration `20261104212300_structured_section_body_bound.sql`
changes only that CHECK: free text retains the 100,000-character ceiling; larger
bodies must be bounded by their own complete array `content_blocks::text`
character length. Existing source/model/authoring/snapshot/export limits remain.
There is no truncation, replacement prose, new fixed larger allowance, row rewrite,
procedure replacement, permission change, or relaxation of content/approval scans.

Seven focused migrated SQL/API tests pass. They cover generated text/tables,
authored text and JSON-table projections, a derived compliance matrix, full
body/source hashes and ordinary export projection, legacy/undersized/scalar-source
negative controls, and actual old-row/owner/ACL/RLS/policy/column preservation
across the migration boundary. A missing-input marker and monetary price after
character 100,000 still trigger approval blockers; technical rendering still
rejects the late price. The adopted mixed-script body retains 1,380,472 characters;
its actual ordinary snapshot is 4,146,977 UTF-8 bytes and RenderModel 2,073,219
bytes. These measurements distinguish serialization from PostgreSQL compressed
storage size. See `evidence/section-body-persistence-20261104.json` for fixture,
source/migration hashes and retained red/green log hashes.

Backend typecheck and build pass. Final combined suites, exact native rendering
of the three saved ordinary projections, release manifest/schema refreeze and
hosted acceptance remain separate pending gates. Frontend source/dependencies
were not changed; the parent owns final complete package checks. No deployment,
external provider call, hosted Auth/Storage action or production write occurred.

### November 4 — reproduce the upstream batch capacity failure

The new isolated `upstream_batch_capacity.py` harness uses the real migration
set at `f80858fedeb831ccc754123ab621f24d92978f89`, the existing ordinary-export
fixture, valid proposal sections and authenticated `export.prepare` followed by
real HTTP `app_batch` calls. It does not disable application constraints or
triggers, overwrite an export snapshot, call models or access hosted services.
Its Auth stub and synthetic JWT are explicit fixture boundaries. The accepted
snapshot contains 42 sections and 4,126,748 JSON text bytes; its compressible
content occupies 68,697 stored bytes.

With the exact pinned PostgREST 14.18 image at the repository's declared
128 MiB/500m envelope, one renewal passed: 4,127,587 response bytes in 154 ms,
with the complete response SHA matching the saved batch result and exact
snapshot, revision, order and command receipt checks. A batch of ten renewals
then killed PostgREST: `OOMKilled:true`, exit 137, zero response bytes and no
HTTP headers after 895 ms. PostgreSQL remained alive under the separate local
1 GiB/one-core safety limit, with a 534,106,112-byte kernel peak. That number
includes process memory, cache and the 512 MiB data tmpfs, not only query heap.
The 50 ms REST sampler missed the transient allocation before cgroup removal;
its last sampled peak must not be used as the failed process's peak memory.

The PostgreSQL log records EOF with an open transaction. The subsequent check
found the previous export revision and zero batch/command receipts for the
failed key. The probe stopped at this first application capacity failure;
25/100-command cases, replay and broader concurrency were not attempted.
Both owned containers were removed and cleanup/source hashes verified. Three
earlier fixture-readiness attempts are retained separately and are not capacity
evidence. The public [receipt](evidence/upstream-batch-capacity-20261104.json)
binds all migration/harness hashes, response hashes, cgroup observations and
external log hashes.

This is a reproduced release blocker upstream of the API transport. Streaming
the API response cannot fix the scalar JSONB aggregation or PostgREST memory
failure. PostgreSQL 17.6/local safety limits are not production PostgreSQL 18
or managed database capacity qualification; the live REST resources and managed
database sizing remain separate read-only inventory evidence. No product SQL,
result cardinality, quota or accounting behavior was changed. A reviewed repair
and the same real upstream regression remain open before release acceptance.

### November 4 — complete frontend checks after admission and identity fixes

At `c5b991eeac22e832ec9e2f3ce0018865db3ad449`, frontend typecheck, all
380 tests in 59 files (`--maxWorkers=1`), and production build pass. The test
runner reports 45.67 seconds. Before/after SHA-256 inventories of frontend and
shared TypeScript sources were identical. The
[receipt](evidence/frontend-admission-checks-20261104.json) preserves the exact
commands, source hashes, timings and log hashes. This supersedes the earlier
359-test result only for this newer frontend source. It is not hosted browser
acceptance, a complete backend result, or deployment evidence. Subsequent shared
backend edits still require affected checks and the final release suite.

### November 4 — observe actual hosted capacity configuration

Read-only [inventory run 41916625820](https://github.com/salahassi/tenders/actions/runs/41916625820)
at `84003906146c9b2970641348cfe67d84bb17e210` passed original cluster
CA/hostname verification and both temporary-client/credential cleanup stages.
All ten workloads were ready at observation. The
[receipt](evidence/digitalocean-capacity-20261104-41916625820.json) records
matching deployment and ready-Pod resource limits: API 384 MiB/700m, worker
640 MiB/one core, and REST 128 MiB/500m. REST's configured pool is 5 and maximum
rows 1,000; its fixed authenticator binding was verified without exposing its URI.
These are observed configuration values, not measured process consumption.

The database metadata reports one node and size slug `db-s-1vcpu-1gb`; measured
RAM and CPU remain unknown. The fresh observer login reports `work_mem=2048 kB`,
`max_connections=25`, and `statement_timeout=0`, with no selected application
role/database catalog overrides. These do not prove an authenticated REST
transaction's effective settings. No business mutation, customer-row copy,
model call, application deployment or release-baseline replacement occurred.
The original inventory remains the frozen release baseline. The REST memory
limit now matches the independently reproduced local upstream OOM's envelope;
the repair and exact regression remain pending.

### November 4 — implement atomic batch results with bounded transport framing

CLI-created migration `20261104212818_bounded_command_batch_results.sql` keeps
the existing 100-command/1 MiB input contract and calls the current public
dispatcher within one workspace-locked transaction. It stores each actual
returned result as canonical UTF-8 bytes in fixed 256 KiB private chunks and
returns a small ordered manifest. It does not build a growing JSONB batch array
or infer results from child command receipts. Descriptor/chunk hashes and exact
lengths bind every result. Authenticated reads recheck the original actor,
current membership, expiry and purge state; private tables/helpers have no new
browser or service grants. Canonical base64 has no inserted line breaks.

Both old aggregate RPC entry points now fail with
`TRANSPORT_UPGRADE_REQUIRED` before effects. Existing legacy receipt rows and
function authority remain unchanged. An existing legacy batch key currently
fails with `BATCH_LEGACY_NORMALIZATION_REQUIRED` before any command is repeated.
This is an explicitly unfinished compatibility gate, not a release-ready
fallback. The rollout must fence old API/direct-RPC admission and settle
already-running legacy transactions; changing a function body alone does not
stop an in-flight old invocation.

The new completed cache has the existing 24-hour retention boundary. While an
expired receipt remains present, a retry returns `BATCH_RESULT_EXPIRED` instead
of silently executing commands again. Existing workspace-locked maintenance
then removes expired cache rows. Purge preserves the original UUID-match scope:
each chunk plus the next same-result chunk's first 35 bytes is checked without
rebuilding the result. Only matching receipts are invalidated; unrelated cached
results remain readable. Purge and late failures remain transactional.

Local PGlite evidence: all 16 new functional cases pass, including historical
row/ACL preservation, full UTF-8 reconstruction, replay, late-command rollback,
current ownership, expiry, exact cross-boundary purge, unrelated-result survival
and late-purge rollback. The public-dispatch model-route regression passes
(one selected test, 89 skipped), and backend typecheck passes. A first-run SQL
variable-qualification failure and the subsequent test-only type annotation
are recorded in the [scoped receipt](evidence/command-batch-chunks-sql-20261104.json).
Dependencies were reused through temporary links to both root installations;
no dependency versions changed. No hosted/model calls occurred. Actual
PostgreSQL/PostgREST chunked capacity, authoritative legacy normalization,
guarded cutover, source-bound release capabilities and final integration remain
open; no deployment or final capacity qualification is claimed here.

### 2026-11-04 — Metadata-only legacy BATCH exposure census preparation

A new additive `legacy_batch_observation` reads only the fixed BATCH/commands
idempotency namespace. It groups global active/expired counts by fixed compression
class and reports SQL-null counts and stored-byte sum/max/threshold counts through
PostgreSQL metadata functions. No result JSON is expanded or emitted; no keys,
identifiers, actors, workspaces or customer content leave the query. Only the
at-most-eight aggregate groups are materialized. Existing read-only owner scope,
20-second statement timeout, 5-second lock timeout and cleanup remain unchanged.
The original inventory schema and release baseline inputs are untouched.

Compressed stored bytes are explicitly not logical/wire capacity. Purged sentinel
state remains uninspected, and SQL null is not interpreted as purged. The 64 KiB
and 1 MiB cumulative metadata buckets add no product quota. Operations reviewed
the exact query and found no blocker. This is local preparation for a separately
reviewed read-only runner inventory; it performs no replay, normalization,
mutation, provider call or hosted dispatch.

Verification: 32 focused tests pass in 2.65 seconds, plus Python compilation and
diff checks. The actual PostgreSQL-through-PGlite fixture covers empty state,
compressed 2 MiB synthetic input stored below 64 KiB, uncompressed medium/large
results, SQL null versus JSON null, an uninspected sentinel, active/expired rows,
and exclusion of other methods/routes. The fixture proves metadata behavior and
unchanged row count, not hosted exposure or replay normalization capacity. Strict
projection tests reject private labels/extra fields and inconsistent counters;
census failure still verifies cleanup. Existing inventory and capacity tests
remain green. No native benchmark or hosted service call ran in this change.


### 2026-11-04 — Bounded command-result transport after upstream aggregation failure

Implemented API transport for the separately owned normalized batch SQL
contract. One mutation RPC returns a small immutable receipt manifest; result
RPCs return at most 256 KiB of original JSON bytes per chunk. The external
`data` array and `meta` envelope retain all results, order, nulls, numbers and
Arabic strings. This framing introduces no total-result quota. The unused
`Backend.batch` aggregate convenience method was removed.

The consumer validates exact receipt/ordinal/index/length framing, canonical
base64, each chunk hash and an incremental whole-result SHA-256 before finishing
a result. It never collects a result into one buffer. Reads occur only on
downstream demand. Aborted or late uncooperative reads retain admission until
they settle. Read errors, including SQLSTATE 57014 after committed mutation,
never advertise or perform a mutation retry. Current SQL authority is checked
by every chunk RPC; the API uses the original caller JWT and fixed local URLs.

71 focused protocol/actual-handler tests passed in 0.694s. The three adapted
canonical database/HTTP/delivery fixture files passed all 31 tests in 13.09s;
backend typecheck passed. Independent source review found no material transport
blocker. Evidence and source/dependency hashes are in
`evidence/api-batch-chunk-transport-20261104.json`. Fixtures use actual migrated
SQL with synthetic PostgREST/Auth/Storage, so they do not prove upstream native
resource capacity.

Deployment remains gated by the separate SQL migration and exact historical
receipt normalization/cutover, plus actual PostgREST/API resource qualification.
The legacy aggregate RPC must not remain an unbounded fallback. No provider
calls, production writes, model/billing policy changes or deployment ran here.


### 2026-11-04 — Reviewed DOCX upload uses the canonical export archive budget

Reproduced the original-file policy conflict through the actual completion
handler: a source-matched ordinary-2 DOCX of 3,177,596 compressed bytes and
298,012,602 reported expanded bytes returned `FILE_CONTENT_MISMATCH` before
canonical verification, with zero completion calls. The computed model hash
exactly matches the renderer's saved model. Auth/Storage/context authority in
this fixture is synthetic and explicitly supplies the ordinary-2 pin; it is
not evidence of SQL package admission.

DOCX completion now checks its filename/MIME identity, ZIP signature and 10 MiB
compressed upload limit, then runs the existing complete canonical async DOCX
verifier before the final completion RPC. The verifier still checks supported
ZIP/XML structure, CRC, active entries, exact visible content/placeholders and
its source-derived expanded budget. This is no document-validation bypass.
`originals.ts`, original RFP uploads and reviewed PDF validation/200-page policy
remain unchanged.

12 focused actual-handler/envelope tests passed in 1.23s, including a small
native canonical positive, foreign-document/malformed-archive rejection,
filename/MIME/signature errors, unchanged original-RFP bound and both PDF
controls. Backend typecheck passed; independent source review found no material
blocker. See `evidence/reviewed-docx-upload-envelope-20261104.json` and the
reproducible `scripts/testing/reviewed_docx_handler.mjs` harness.

Acceptance of the same large artifact through the corrected handler/native
image is still pending its separate scheduled resource test. Neither the
observed old rejection nor small positive controls qualify native peak memory.
No provider/production calls, deployment or resource-policy increase occurred.

### November 4 — actual legacy batch exposure is zero at observation

Read-only [run 41919585078](https://github.com/salahassi/tenders/actions/runs/41919585078)
at `e0ce84d2cb770fd09d5192a398833b88f0c2628b` passed original-CA/hostname
verification, the inventory guards and both temporary-client/credential cleanup
stages. At 21:49:50 UTC, the authoritative BATCH/commands namespace contained
zero total, active and expired receipts. No result payload was expanded, copied
or exposed. The [receipt](evidence/digitalocean-legacy-batch-20261104-41919585078.json)
retains the exact metadata census and observed workload configuration. Bootstrap,
restore and model modes were skipped; production business mutations were zero.

This closes uncertainty about historical batch exposure only at that observation.
Release still must fence old API/direct-RPC admission, settle in-flight legacy
transactions and recheck zero under the migration's locking protocol. Any new
legacy receipt must stop that cutover before effects; this observation must not
be treated as a durable zero-state guarantee or permission to discard history.
The existing typed legacy gate remains, and the original release baseline is
unchanged. No application rollout or hosted proposal acceptance occurred.

### November 4 — qualify the complete upstream chunked batch at100 commands

The actual pinned PostgREST 14.18 process passed sequential batches of 1, 10,
25 and the existing maximum 100 renewals at unchanged 128 MiB/500m. Each result
contained the valid 4.13 MB serialized synthetic export snapshot used for the
earlier ten-result OOM reproduction. The 100-result case delivered all
412,758,838 array bytes through 1,600 independently authenticated chunks in
84.853 seconds; its mutation/manifest response took 5.994 seconds. Every chunk
identity, decoded length, SHA, complete result SHA, result order and expected
revision matched. No legacy aggregate receipt was created.

At100 results the kernel peaks were 46,141,440 bytes for PostgREST and
193,982,464 bytes for local PostgreSQL. The latter includes processes/cache and
the bounded data tmpfs under the separate 1 GiB/one-core fixture limit. Both
processes remained alive with no OOM. Replaying the maximum request returned
the identical small manifest in48 ms without new business/audit/receipt/chunk
writes. A later real revision conflict after ten successful large commands
rolled all of them back. Source hashes and removal of both owned containers
were verified. The [receipt](evidence/upstream-batch-chunks-capacity-20261104.json)
binds the exact SQL/harness, per-case measurements and external log hashes;
the earlier aggregate-path OOM evidence remains retained.

This qualifies the recorded upstream protocol and compressible structural
fixture, not actual Auth HTTP, full writer/generation reachability, an API image,
a browser, managed PostgreSQL 18 sizing or production SLOs. It precedes the
approved legacy INSERT-backstop amendment, which needs separate concurrency
proof and final source binding. Admission fencing/drain, a locked zero legacy
census, final API memory qualification, release capabilities and hosted
acceptance remain open. No model, customer-data or production operation occurred.

### November 4 — fence late legacy BATCH inserts atomically

The unreleased bounded-batch migration now installs an INSERT-only trigger that
raises `TRANSPORT_UPGRADE_REQUIRED` for the old BATCH/commands receipt. A cached
old function cannot commit its earlier business writes after that final insert
is rejected. Existing historical rows, purge UPDATEs and retention DELETEs are
unchanged. All 17 scoped functional tests pass (2.84 seconds); the
[receipt](evidence/command-batch-insert-fence-20261104.json) binds exact sources.
The already-written transaction and pre-table cached-function races still need
actual PostgreSQL proof. The release's early exclusive lock, locked zero census,
gateway admission fence, old-transaction drain and final capacity gates remain
separate prerequisites. No hosted action or deployment occurred.

## November 4 — A06 independent Arabic OCR diagnosis and rejected tuning

**Implementation:** added an explicit bounded native diagnostic tool and a stricter
whole-page oracle for fixed synthetic gold. No runtime recognizer, handler,
migration, source-eligibility rule or page-review requirement changed. The oracle
rejects extra negation, reordered conditions and altered numeric punctuation;
ordered substring presence alone no longer counts as complete recognition.

**Actual native evidence:** the pinned existing OCR image reproduced the historical
Arabic failure, including its exact image/text hashes and confidence 82. A fixed
18-setting matrix found one complete original-case match (1000px, Arabic-only,
PSM 6). Independent pre-authored/frozen holdouts then rejected that candidate:
all three Arabic/mixed pages failed complete gold and lost their English IDs;
the unchanged English control regressed from exact/confidence96 to unreadable/24.
The existing default also failed all three independent Arabic whole-page cases.
Raw historical scores remain intact; the stronger independent adjudication is
separate. Isolated containers used network-none/768MiB/oneCPU/64PIDs and were
removed after completion. No further parameter search or external calls occurred.

**Validation:** all 16 focused pure oracle regressions passed (124ms), including
independent-review negatives for leading decimals and punctuation inside IDs.
Backend `npm run typecheck` and `npm run build` both passed. Full combined
package checks remain root-owned; no frontend/runtime code changed. Native Arabic qualification remains failed; the
ordinary native gold suite is deliberately not relabeled green. The new diagnostic
runner packages the measured procedure but has not itself been rerun as a rebuilt
image. Original frozen gold/PDFs and independently prepared holdout gold are not
changed to accommodate engine output.

**Deployment / remaining:** no deployment or hosted claim. A06 remains open for
automatic Arabic extraction. Qualify a different recognizer/policy against an
independent Arabic/mixed corpus, or retain current source-bound visual correction
and explicit coverage gaps. Opportunity language is not a verified page-language
classifier. No genuine Microsoft Word engine was available; the separate Word
update/save gate remains open. See `docs/ARABIC_OCR_DIAGNOSTIC.md` and
`docs/evidence/uploaded-ocr-adjudication-20261104.json`.

## November 4 — A06 official best-model comparison rejected

**Implementation:** inspected the existing pinned OCR image and established that
Debian's Arabic and English language packages use `tessdata_fast`. Added one
explicit offline qualification harness and a pre-output plan for official
`tessdata_best` Arabic and English files, pinned to upstream commit
`e12c65a915945e4c28e237a9b52bc4a8f39a0cec`. Runtime recognition, source eligibility
and mandatory visual page review were not changed. Independent source review
verified all asset, source, gold, oracle and page-selection hashes. A preserved
successor plan fixed incomplete-result recording before any recognition output;
the candidate and all test inputs remained unchanged.

**Actual native evidence:** the exact seven planned cases ran at 768 MiB/one CPU,
with network disabled and read-only inputs. Three controls passed: English,
the selected English scan within a mixed PDF, and its blank page. All four Arabic
pages failed the unchanged complete-page oracle. The candidate is rejected;
no output-driven parameter search followed. The records-retention defect is
reported as a malformed prohibition token without asserting that its intended
meaning necessarily reverses. The run completed in 4.88 seconds including cleanup;
peak memory was 164,823,040 bytes, with no out-of-memory or swap events. All source
hashes stayed unchanged and the container was removed. The explicit quality gate
was false, exit 1; infrastructure failures and skipped cases were zero.

**Validation:** backend typecheck and build passed; all 16 existing pure OCR oracle
regressions passed in 111 ms. The actual seven-case candidate run is deliberately
reported as a quality failure, not a green accuracy suite. Full combined package
checks remain root-owned. The earlier frozen controls have known prior-model
outcomes; this comparison does not establish a blinded or universal accuracy rate.

**Deployment / remaining:** no deployment, provider inference, customer data or
hosted acceptance. Automatic Arabic OCR remains unqualified; preserve the current
source-bound visual correction workflow. Official best-model branding did not
resolve the observed obligation and qualifier failures. See the updated
`docs/ARABIC_OCR_DIAGNOSTIC.md`, frozen plan
`docs/evidence/uploaded-ocr-best-plan-v2-20261104.json`, raw results and separate
`docs/evidence/uploaded-ocr-best-adjudication-20261104.json`.

### November 4 — qualify the permanent legacy command RPC gateway fence

Both gateway ports now reject the retired `app_batch` and `apply_batch` RPCs
with a typed HTTP409 `TRANSPORT_UPGRADE_REQUIRED` response, `retryable:false`
and `Cache-Control:no-store`. New command preparation/chunk RPCs, ordinary REST
reads, Auth and standard Storage routing remain available. Ambiguous encoded
protocol/function segments are rejected before a downstream second decode;
query values do not affect the path guard. The existing TUS denial is unchanged.

The [actual pinned Nginx receipt](evidence/legacy-batch-gateway-20261104.json)
records560 method/path cases,76 TUS cases and24 positive routing controls across
8080/8081. A synthetic recording upstream received none of the denied requests;
both new batch RPCs reached the expected upstream. Restart preserved the fence.
The first native run caught an over-escaped character class that also denied
the new preparation RPC; its [failure receipt](evidence/legacy-batch-gateway-regex-regression-20261104.json)
is retained and the identical matrix passed after the narrow correction. These
are isolated routing tests, not successful business operations or load tests.
Both owned containers were removed; no host ports, credentials, customer data,
models, production calls or database changes were involved.

The gateway source contract is version2: it binds the unchanged physical/TUS
receipt and its exact prior config, then the new actual combined-config routing
receipt. Historical evidence is not relabeled to match changed source. The CAS
helper also supports a coordinator callback after rollout and before accepting
current Pods, so durable old-process exit evidence can precede final acceptance.
The focused helper/render suite passes32 tests; Python compilation and diff
checks pass. Full package gates belong to the combined root integration.

Deployment remains pending. The gateway fences supported callers, while the
current NetworkPolicy still permits direct REST from the namespace. Release
must verify actual runtime gateway bindings, drain observable old transactions,
acquire the legacy-table lock before the repeatable-read snapshot, then recheck
zero and install the permanent SQL INSERT backstop. The routing receipt does not
claim those database or hosted cutover guarantees; the coordinator owns them.

### November 4 — integrated package diagnostic and complete-response test corrections

At `256c50e`, both packages passed typecheck/build; frontend passed all380 tests
in59 files. The full backend run completed with3,135 passes and two failures
across189 files in468.51 seconds. All899 captured source hashes were unchanged.
The [diagnostic receipt](evidence/combined-app-diagnostic-20261104-256c50e.json)
preserves the exact commands, hashes, durations and failures; this is not a full
green backend result.

Both failures were direct-handler tests that read only the successful response
status before making another request. The new heavy-file permit correctly
remains held until response EOF/cancellation, so the subsequent approval/actor
assertions saw busy503 rather than reaching their intended checks. The ordinary
final-export test now consumes and checks the complete byte count before
invalidating approval; the OCR correction test consumes and checks the accepted
response before attempting a forged actor. No product gate, permission or
approval rule was weakened.

All33 tests in the two affected files and backend typecheck pass after these
corrections; [scoped receipt](evidence/completed-response-regressions-20261104.json).
A complete final backend rerun remains required after the remaining source
integration. No deployment, provider call or hosted acceptance occurred.

## November 4 — actual API batch capacity harness preparation

**Implementation:** added an isolated actual-image API -> real PostgreSQL/
PostgREST harness for the existing 100-command/near-4.13MB serialized export
fixture. It hashes each complete result incrementally, retaining only bounded
metadata and hashes. It checks slow-consumer busy, EOF release, same-key replay,
cancellation after the first chunk settles, and exact revision/audit/command/
batch deltas. No application runtime, SQL, admission cap or resource limit changed.

**Scope:** Auth user lookup is explicitly synthetic; membership and SQL authority
use the real caller JWT. A loopback HTTP prefix adapter forwards real REST bytes.
The actual immutable image entrypoint/heap settings are retained, but the command
replaces runtime/main.ts with the harness and loads the same inactive module graph.
Source hashes include actual image functions/runtime/frontend library files.
The fixture directly seeds permitted structural rows before authorized export;
it does not establish generator reachability or managed database sizing. Partial
cancel control is after a settled chunk, not in-flight SQL cancellation.

**Checks:** five pure stream-oracle tests passed, backend typecheck/build passed,
and Python syntax passed. Independent source review identified and closed the
missing runtime-module-graph baseline. No native run or memory/timing pass is
claimed in this preparation commit. Root schedules the bounded real-container
measurement separately; all source/receipt/cleanup outcomes remain explicit.
See `docs/API_BATCH_CAPACITY.md`. No production, provider or customer calls.

### November 4 — qualify cached legacy transactions and bind the24-migration release

Four actual PostgreSQL17.6 cases passed under isolated capped containers. A
cached old function waiting before receipt-table access resumed after cutover,
hit the INSERT fence and rolled back every business/audit/command write. An old
transaction already holding its receipt-write lock committed while the release
waited; the release's first snapshot then saw that receipt and rejected the
migration. Existing expired history was likewise preserved on refusal. New
bounded results and identical no-write replay passed. Source hashes and container
cleanup were verified in the [race receipt](evidence/command-batch-cutover-postgres-20261104.json).

The release now locks the receipt table before the first repeatable-read query,
refuses any old BATCH/commands history, freezes all24required migrations and
checks new RPC ownership, browser/private ACLs, column grants, RLS, chunk bounds
and the active INSERT trigger. The managed atomic gate passed44injected fault
rollbacks plus baseline/replay/drift checks (86.979seconds);26pure source/inventory
checks passed. [Source evidence](evidence/command-batch-release-guards-20261104.json)
retains exact scope. Inventory accepts the earlier capability receipt shape and
the complete new batch extension; neither asserts a claim about payloads.
Gateway v2 source binding, live API upstream verification, durable gateway exit
proof and bounded old-transaction drain remain separate coordinator work. No
hosted change or final API/runtime qualification is claimed.

### November 4 — bind combined gateway qualification without rewriting old proof

The release manifest uses gateway contract version2: its current combined route
receipt binds both legacy RPC denial and retained resumable-upload denial, while
the unchanged historical Storage physical proof stays bound to the prior config
that it actually exercised. Retirement validates this exact chain before its
existing installed-gateway/current-process checks. The source-freeze helper and
rollout helper produce identical contracts from the committed actual receipts.
Nine pure release-binding checks and22retirement control-flow tests passed; the
[receipt](evidence/command-batch-gateway-binding-20261104.json) records exact scope.
This slice runs no new native/hosted test. The bounded transaction-drain and
actual old gateway-process exit coordinator remain pending before deployment.

### November 4 — reject semantically disabled batch catalog guards

Release verification now binds the exact normalized legacy INSERT trigger
definition and the exact normalized chunk-size CHECK. A non-null `WHEN(false)`
or an enlarged `CHECK(original_bound OR true)` no longer passes a superficial
presence/substring check. The actual managed atomic fixture rejected both new
faults, as well as the disabled-trigger/missing-constraint controls, with full
rollback; normal release/replay and four baseline guards passed. The
[receipt](evidence/command-batch-exact-catalog-guards-20261104.json) binds this
source-only guard correction. Canonical migration bytes did not change; hosted
cutover and final integrated checks remain separate gates.

### November 4 — preserve legacy SDK error handling during the gateway cutover

The old `Backend.batch` passes the Supabase RPC error directly to
`databaseError`, which reads `error.message`. The first gateway response used
only the nested application envelope; the actual pinned Supabase SDK regression
reproduced a `TypeError` instead of the intended upgrade error. The corrected
response retains that nested envelope and adds fixed PostgREST-compatible
`code`, `message`, `details` and `hint` fields. Both direct gateway and old
adapter outcomes remain nonretryable; the unchanged old mapper reports 422 for
the named upgrade error, while direct gateway HTTP status remains 409.

The [SDK boundary receipt](evidence/legacy-batch-sdk-error-20261104.json)
records two passing regressions using Supabase 2.117.3, the retained old batch
method and the identical historical/current HTTP mapper. Each call sends once;
no command is executed. Fetch transport is synthetic, and this does not claim
the complete deployed old API image or real Auth was tested.

The [new pinned Nginx receipt](evidence/legacy-batch-gateway-compatible-20261104.json)
again passes 560 legacy method/path cases, 76 TUS checks, 24 ordinary-route
controls and restart, now checking both response envelopes. Denied requests
never reach the recording upstream. Both owned containers were removed.
The earlier 089b024a routing receipt and historical physical/TUS receipt remain
unchanged. The version 2 source contract now requires the new exact response
configuration/receipt and `postgrest_error_envelope_qualified:true`; an old
receipt cannot qualify the changed bytes. The 32 focused Python helper/render
checks and backend typecheck pass. No production, model or customer-data
operation occurred.

## November 4 — actual native API100 batch capacity passed

**Actual run:** root `6a73cafc0933723f6441a9b448d49443200d37ad`, final batch SQL
SHA `7bb805fefa6584e02ae8ef65fc6117fb86a9c48b2a8fcf4502e1e7783fe2dc22`, and
immutable API image `89afc8a31d76e1616ad17e5896e0fc54f0acdc41cd7da389af456386f3e998fe`.
The full API/worker/browser/scheduler module graph was loaded. The actual API
handler/Backend.batchStream used real JWT membership and migrated PostgreSQL/
PostgREST; only Auth lookup and loopback path-prefix routing were fixture adapters.
No product source or parent heap/resource override was mounted.

All100 result hashes and canonical SQL snapshots matched across1,600 chunks.
412,758,765 full-envelope bytes streamed in58.024s, headers6.140s, with no aggregate
response parsing. API cgroup peak163,995,648/402,653,184 bytes; no max/OOM/kill events.
Sampled process RSS208,576,512 is separately recorded. Slow consumer busy503 skipped
heavy upstream work; EOF and cancellation after one settled real chunk both
allowed a subsequent heavy read. Same-key replay/cancel added no mutations:
revision1→101, audits4→104, COMMAND receipts3→103, one batch,1,600 stored chunks.
Health114; all three owned containers removed; source hashes unchanged.

**Limits:** one synthetic, directly seeded structural fixture followed by actual
authorized export.prepare; near4.13MB serialized snapshot is not near4MiB physical
storage or proof of generator reachability. This is not hosted Auth/NGINX, cold
start, browser aggregate parsing, arbitrary-size/concurrent-load or issuance-SLO
acceptance. No provider, production or customer calls. Evidence:
`docs/evidence/native-api-batch-capacity-20261104.json`; raw local receipt remains
under `/workspace/output/api-batch-capacity-r1/receipt.json`. Deployment and final
combined checks remain separate root-owned gates.

### November 4 — retain actual gateway identities and drain only pre-fence transactions

The release coordinator now checks the API's literal gateway upstream and actual
inherited environment using fixed shell builtins that output only true/false.
Before changing the gateway it persists the complete original Pod UID/container
set and protects those identities with a dedicated finalizer. Every termination
proof is durable before finalizer removal. Lost ACKs, immediate garbage
collection, partial exit, missing identities and concurrent journal changes
remain fail-closed. An absent original journal cannot adopt an already changed
or partially changed gateway. The permanent route fence is never rolled back.

After actual old gateway exits, a database clock marker bounds a metadata-only
drain of the fixed authenticator login's old transactions. The existing SET
authority is sufficient: the observer assumes that exact login role in a read-only
transaction and excludes its own backend. It grants no global monitoring rights,
terminates no sessions, and preserves pending sessions on timeout or unknown
visibility. Seven actual PostgreSQL 17.6 cases passed for active and idle sessions
that changed local JWT roles, direct observer self-exclusion, hidden/USAGE-only
refusal, a fixed cutoff, natural commit and failure handling. The final helper
hash and cleanup are bound in the [activity receipt](evidence/command-batch-activity-postgres-20261104.json);
the initial harness decoding failure and earlier successful source are retained.

Thirty coordinator/updater tests and nine pure release-binding checks passed.
Independent source review found no further blocker. The compatible gateway
receipt is now mandatory, including its actual old-SDK typed-error proof; old
native receipts remain unchanged. [Coordinator evidence](evidence/command-batch-cutover-coordinator-20261104.json)
separates these local checks from actual Kubernetes termination, managed PG18
visibility, final image capacity and hosted acceptance. The early locked zero
census and permanent INSERT trigger remain necessary for queued/direct REST
callers. No hosted mutation or deployment occurred in this slice.

### November 4 — refuse unknown Kubernetes terminal states as exit proof

Gateway drain now binds the terminated state's own container ID to the captured
ID and accepts only known runtime terminal reasons with valid nonzero ordered
start/finish timestamps and a concrete exit code. `ContainerStatusUnknown`,
`NodeLost`, missing or conflicting IDs, invalid timestamps and negative/missing
exit codes retain the Pod identity and refuse settlement. Saved proof replay
uses the same validation; a known OOM/error exit proves process termination,
without claiming a clean shutdown. All 34 focused control-flow tests passed.
The [receipt](evidence/command-batch-process-exit-fence-20261104.json) records that
the three observer SQL/drain functions are byte-identical to the actual seven-case
PostgreSQL-qualified revision; those unrelated probes were not repeated. Actual
hosted Kubernetes exit proof remains pending. The final gateway source hash is
also pending the separately assigned slow-consumer streaming qualification.

### November 4 — prepare read-only hosted transaction visibility verification

Inventory now calls the release helper's exact read-only transaction observer
using the existing temporary SQL client. Only fixed-role metadata, a database
marker, count and observer-SQL hash are returned. It uses existing SET authority
to the exact authenticator login; it neither grants global monitoring privileges
nor installs a gateway fence, waits for sessions, terminates sessions or changes
customer records. Unknown/hidden/malformed visibility fails closed, and client
cleanup remains mandatory. The original release baseline is unchanged.

Four focused projection/privacy/failure/cleanup checks and all17 existing
inventory tests pass. Actual PostgreSQL authority/drain behavior is separately
qualified by the shared helper's owner; these local mock checks do not prove
managed PostgreSQL18 authority. A reviewed original-CA runner inventory is still
required before claiming hosted visibility. The helper dependency is supplied
by the separate release-coordinator commit; it is not duplicated in this change.

### 2026-11-04 — A05/D07 source reserve frozen before outputs; activation remains closed

Added `QUALIFICATION_RESERVE.md`, 50 bilingual source/oracle cases across all 13
registered tasks, and 16 separate bilingual retrieval pairs with compact, bounded
and preflight-excluded source recipes. The proposed schedule is 100 observations
per model (96 semantic, four connectivity), with two fixed repetitions and no
automatic retries. The 48 retrieval cells are prospective, not executed. Exact
source hashes/code-point spans and earlier pre-output versions are preserved.
Independent source-only reviews corrected scope, duration/effort, source provenance,
source-page mode and trace paths before outputs. This synthetic reserve was authored
after known development outcomes; it is not a blind or private holdout.

The offline lock/scorer binds each observed input, prompt, schema, contract, adapter,
validator and resolved target to frozen identities. Actual provider-reported identity
is separate: unknown remains unknown; unexpected identities fail. Missing/quota/
transport/refused/malformed/partial judgments retain denominators and cannot pass.
One known critical semantic error remains a failure even beside incomplete judgments.
The draft activation contains no providers, authorization or executable schedule.

71 focused mechanical tests passed in 422ms; backend typecheck passed. The CLI
integrity check confirms 50 cases, 13 tasks and 48 prospective retrieval cells.
Synthetic test receipts/verdicts are arithmetic/integrity controls, not actual model
outputs or business quality. Evidence: `evidence/qualification-reserve-freeze-20261104.json`.
No provider calls, retrieval executions, deployment or production writes occurred.

A05/D07 remain open for qualified production task adapters and source/authority
contexts, real authorized targets and full request locks, actual evaluation and
independent output adjudication, noncritical business acceptance decisions, and an
authorized private independently reviewed holdout. Prior live critical findings and
G09's seven measured retrieval misses remain unchanged. Full combined application
checks belong to the separate integration gate; this scoped tooling check does not
repeat or replace them.

### November 4 — reconcile remaining actions and R0 evidence at 256c50e

Refreshed [remaining actions](RELIABILITY_REMAINING_GATES.md), their machine
matrix and the [R0 index](evidence/reliability-r0-index-20261104.json) against
tracked source 256c50e. Historical receipt hashes remain unchanged. Added the
frontend 380/59 pass, API/client admission and identity evidence, complete
structured-body persistence, real REST 100-command chunks, warm-two/fresh-one
native downloads, same-artifact reviewed DOCX red/green, hosted zero legacy
census, pinned gateway routing and rejected OCR tuning. Native document results
retain their synthetic upstream scope and narrow 10.88 MiB minimum margin.

The manifest file still contains 22 migrations while source contains 24; refreeze
and a renewed exact 24-migration cloud restore remain pending. The final release
guards/coordinator, queued db52ae9/d15cbe7, actual API batch memory, deployment
and hosted acceptance are not credited as complete. Current full application
checks were running at this anchor, with the reported unconsumed-response
direct-handler test failure awaiting correction; no final full-green claim is
made. The new pre-output model reserve is in review, not blind qualification.

This change updates documents only. Static validation confirms every indexed
receipt exists and its SHA256 matches, all historical index rows/hashes remain,
the nine action IDs are unique and all action evidence references resolve.
No application, native, provider or production test was run by this refresh.

### November 4 — observe gateway resources and temporary-storage configuration

The existing read-only inventory now includes gateway deployment and ready-Pod
resource requests/limits in its additive capacity observation. It separately
projects fixed entrypoint recognition and sanitized temporary-volume facts:
exact/descendant mount counts, source kind, configured medium/size limit,
read-only status and subpath presence. Unknown/missing values stay unknown; no
repository default substitutes for actual observations. Secret values, arbitrary
paths and volume names are omitted. A Kubernetes sizeLimit is explicitly not
reported as a proven hard filesystem cap. The original workload/schema receipt
shape is unchanged, and no resource, credential or permission is modified.

All 22 focused projection/inventory tests passed, including four new controls for
deployment/Pod drift, unknown storage, submounts and redaction. The
[source receipt](evidence/gateway-inventory-capacity-projection-20261104.json)
records local checks only. Hosted values and the separate qualified gateway
preflight/response-streaming acceptance remain pending the reviewed runner run.

### November 4 — managed PostgreSQL visibility and actual gateway envelope verified

Original-CA inventory [run 41926843276](https://github.com/salahassi/tenders/actions/runs/41926843276)
passed at `da3c4bcde412f17287f7abd3c5c28779abda26d3`, including both cleanup
stages. The existing exact-role SET authority exposed authenticator transaction
metadata on the managed database; zero old transactions were observed at its
database marker. No grants, session termination, admission fence or drain ran.
The [receipt](evidence/digitalocean-cutover-20261104-41926843276.json) binds the
exact observer SQL hash and retains the zero legacy BATCH census separately.

The actual gateway Deployment and ready Pod both specify 64 MiB / 200m limits
and the recognized Nginx entrypoint, with one writable default-medium /tmp
emptyDir configured at 64 MiB, no subpath or descendant mounts. These observed
specs bind the isolated qualification envelope; they do not measure cgroups or
prove hard filesystem enforcement. All ten workloads were ready. The 41 local
inventory checks passed before dispatch. No application deployment, model call,
bootstrap, restore or business write occurred. The original frozen release
baseline is unchanged; final gateway qualification, manifest refreeze, renewed
restore and actual fenced cutover remain separate gates.

### November 4 — distinguish declared HTTPS capacity from observed limits

The additive capacity inventory now also projects HTTPS deployment and ready-Pod
resource requests/limits through the existing allowlist. Missing values remain
unknown, Pod/deployment differences remain visible, and no TLS/environment
secrets or configuration text are emitted. The existing resource reads are
reused; no new calls or mutations are added. All 23 focused tests passed,
including the HTTPS unknown/drift/redaction regression.
[Projection evidence](evidence/https-inventory-capacity-projection-20261104.json)
records local checks only. The repository's 128 MiB/300m declaration is not yet
reported as observed; the next reviewed inventory must establish actual values.

### November 4 — actual HTTPS resource envelope observed on DigitalOcean

Read-only [run 41928176279](https://github.com/salahassi/tenders/actions/runs/41928176279)
passed at `f331c28f727f19623715be00f98a001bd04185bb`, with original cluster CA
and both cleanup stages verified. The actual HTTPS Deployment and ready Pod
both specify 128 MiB / 300m limits and one container; the immutable deployed
image remains `3a539c44f0907ba846f70ae6e97f477cccf2a34cc84cc492201d5d73e7cfa7ce`.
The [receipt](evidence/digitalocean-https-capacity-20261104-41928176279.json)
records observed specs, not measured native capacity, TLS throughput or volume
filesystem type. Existing-role transaction visibility and zero legacy receipt
counts were observed again; no fence/drain, grant, provider call or application
mutation ran. The original release baseline is unchanged. Five focused HTTPS/
gateway projection tests passed before this dispatch. The separate actual-image
proxy-chain proof and final release checks remain pending.

### 2026-11-04 — Initial reserve adapters use production helpers; ten cases constructible

Added offline `reserve-adapters.ts` for ten of the 50 frozen reserve cases: bilingual
retention analysis, advisory review, four source-page cases and two protocol probes.
The other 40 remain explicitly unsupported; the 100/model denominator is unchanged.
No source identities are concatenated, no prior model results are fabricated, and
no live campaign suite is exposed. The exact prerequisites and existing campaign
integration limits are in `QUALIFICATION_RESERVE_ADAPTERS.md`.

Construction uses actual `generation.taskInput`, current exact span/source contract,
`pinSemanticPrompt`, source-page prompt projection and `executeModel` preparation,
stopping before send/reservation/fetch. Original source aliases map explicitly to
canonical UUID/span/page IDs. Empty administrative fixture context adds no buyer
facts and is not authenticated SQL admission. Separate actual system and user prompt
hashes feed the full prompt pin, while durable input identity remains unchanged.

140 focused tests passed in 2.41s (69 adapter/control plus 71 reserve-integrity); backend
typecheck passed. Controlled in-process responses exercise actual source materialization,
model-forged review neutralization, source/coverage rejection and dispatch-only source
mode restrictions. These are not provider outputs or semantic qualification. Independent
source review found an invalid synthetic review target; a real command-schema regression
failed before the existing `general/general` convention fixed it. Final core reread
found no material blocker. The receipt preserves that red and a later test-harness
wire assertion correction for the existing appended JSON schema.

Evidence: `evidence/qualification-reserve-adapters-20261104.json`. No provider calls,
production retrieval execution, database writes, deployment, billing or model-policy
changes occurred. Remaining: reviewed composite schedules; frozen typed requirement/
blueprint/draft/candidate/repair prerequisites; complete actual target/request locks;
authorized live evaluation and independent adjudication; private holdout and noncritical
business decisions. Full combined checks remain the separate root integration gate.

### November 4 — bind HTTPS runtime and both proxy capacity proofs before release

The release contract now requires a separately qualified HTTPS image and public
Caddyfile, the actual deployed image digest and its image ID, the exact gateway
source, and the retained TLS/compression receipt. The read-only preflight and
readback check the Deployment and every ready Pod: minimum 128 MiB/300m limits,
actual running image identity, exact command, four permitted mount locations,
three literal environment entries, loaded public Caddyfile, and stable process
identity. These checks neither read TLS private files nor alter resources or
configuration. A changed spec while an old binary still runs is rejected.

The gateway proof chain additionally requires the corrected disk-backed streaming
receipt, its exact hash in the routing receipt, the 64 MiB/200m measured envelope,
the 412,758,765-byte synthetic payload, complete open-unlinked-file accounting,
and an allowlisted actual filesystem magic. A tmpfs run cannot qualify the disk
case. Earlier receipts remain historical evidence; this change does not freeze
or accept the superseded disk claim. The cloud-restore source gate now refuses a
manifest missing the HTTPS binding before any capture or fixture creation.

Local validation: 30 pure HTTPS boundary tests, 11 pure release/source tests,
15 updater fault tests, and 13 cloud-restore helper tests passed. Temporary test
receipts are explicitly synthetic; they are not native qualification evidence.
[Guard evidence](evidence/https-release-capacity-guards-20261104.json) binds the
source and logs. Canonical SQL is unchanged. Corrected gateway native proof,
final HTTPS six-case native proof, final manifest freeze, renewed isolated cloud
restore, and hosted preflight/deployment/readback remain separate required gates.
Root's read-only runs observed gateway 64 MiB/200m and HTTPS 128 MiB/300m in both
Deployment and ready Pod specs; those observations alone do not prove cgroup
headroom, storage enforcement, concurrent load, or issuance latency.

### November 4 — preserve unsuccessful explicit TOC-refresh diagnostics

The existing LibreOffice visual harness converts DOCX to PDF without an explicit
document-index refresh call. Two bounded attempts used an isolated personal
macro profile to request that refresh on one existing synthetic English fixture.
Both exited zero without producing the required markers or new PDF/DOCX; neither
is accepted as refresh execution. The first startup replaced the module registry
with its default; the second retained the requested module but still supplied no
execution evidence. Both owned processes exited, and the original DOCX hash is
unchanged. The [diagnostic](evidence/toc-explicit-refresh-diagnostic-20261104.json)
preserves these failures rather than treating process exit zero as success.

No renderer, canonical validation, source text, page numbers or production state
changed. The reason for the absent caches is not established; the earlier 18-file
LibreOffice result and the separate Microsoft Word update/save limitation remain
open. No Word engine, model or hosted operation was invoked.

### November 4 — qualify large API responses through the exact gateway configuration

Both API proxy locations now disable response buffering, and the gateway pins
one worker under its unchanged 64 MiB/200m limits. Request buffering, the 32 MiB
API upload limit and other routing are preserved. Pinning the worker count
removes the test-only `auto` substitution and makes the tested process shape
the production configuration.

The [final pinned-image transport receipt](evidence/api-proxy-streaming-pinned-worker-20261104.json)
delivers 412,758,765 deterministic bytes with the exact expected hash through
both ports. The slower client completes in 32.587/32.518 seconds; peak gateway
memory is 8,777,728 bytes with no out-of-memory event. The disk-backed workspace
mount is verified inside the container by filesystem magic `794c7630`. The
continuous census includes open-unlinked files and stable master/worker process
identities; final temporary usage is only the PID file, 4 KiB allocated. Early
client cancellation closes the upstream and its sent-byte count stops.

The buffering-enabled control, also using one worker, crosses the 64 MiB
temporary budget (67,133,440 allocated bytes) and is deliberately cancelled.
This is an observed budget failure, not a filesystem `ENOSPC`, an OOM, or a
measurement of the previous production `auto` worker count.

Earlier attempts mistakenly used host `/tmp`, which is memory-backed in this
environment. Their disk-medium qualification is explicitly withdrawn by the
[scope correction](evidence/api-proxy-streaming-scope-correction-20261104.json).
Those original receipts, including OOM and observer failures, remain unchanged.
The subsequent disk-backed one-worker-substitution run remains scoped to that
configuration. The [worker binding](evidence/api-proxy-streaming-worker-binding-20261104.json)
records equal executed bytes and the separate final-source rerun; no old receipt
is relabeled as final evidence.

The [final routing receipt](evidence/legacy-batch-gateway-pinned-worker-20261104.json)
again passes 560 legacy method/path denials, 76 TUS denials, 24 ordinary controls
and restart. Its raw TCP client preserves path bytes before Nginx normalization.
The bounded synthetic helper uses an existing pinned small Deno image to avoid
Storage-image copy overhead in the test workspace. No Storage implementation
is replaced or exercised by this proxy fixture.

The version 2 release source contract retains the historical physical/TUS
proof and requires the exact final routing-to-transport hash chain. Preflight
checks the Deployment and actual Pods for image, command, config mount,
resource limits and writable whole `/tmp` mount; running Pods receive a
read-only filesystem check. Final-checksum Pods and final acceptance require
one actual worker. Old `auto` Pods remain the authorized repair input, with
their existing process-exit journal/drain preserved. No resources are patched.

The [focused verification receipt](evidence/api-proxy-streaming-pinned-worker-checks-20261104.json)
records 26 helper, 16 manifest-render and two open-unlinked census tests, plus
two real-SDK adapter regressions. Python compilation, exact source-contract
validation and diff checks pass. All owned containers and disk fixtures are
removed. Integrated package gates, the separate HTTPS chain, final release,
deployment and authenticated hosted acceptance remain separate; this proves
the declared proxy transport fixture, not Auth/SQL behavior or a universal
capacity/service-level guarantee.

### November 4 — prepare full HTTPS compression transport qualification

Added an isolated TLS → pinned HTTPS/Caddy → pinned Nginx → bounded synthetic
JSON stream harness. It retains the exact Caddyfile and explicitly verifies local
CA/hostname trust. The default image is the exact observed deployed HTTPS digest;
a separately rebuilt image has a distinct, source-bound mode. No production
configuration, resource limit, customer row or model request is changed.

The harness covers identity/gzip/zstd, full decoded hash/length, slow reads,
upstream cancellation, health, cgroup memory/swap/OOM, private open-unlinked spool
observation and nonce-owned cleanup. Four small reader/cleanup/receipt/file-census
tests pass. Native execution is a separate scheduled gate; preparation is not a
memory or hosted-throughput success claim. HTTPS128MiB/300m is repository-declared
until the separate current deployment inventory confirms it. See
`HTTPS_STREAMING_QUALIFICATION.md` for exact scope and remaining limits.

### November 4 — correct HTTPS fixture provenance and encoding oracle

The exact deployed HTTPS registry image was acquired with a temporary read-only
registry credential; private credentials were removed without logging values.
The fixture now uses explicit local-only proxy settings, a lightweight pinned
Deno synthetic upstream, and `/workspace/work` overlay mounts with numeric
in-container statfs verification. It observes open-unlinked files and requires
the final production `worker_processes 1` directive and actual process count.
The separate hosted inventory41928176279 confirms HTTPS128MiB/300m; that read-only
observation is distinct from local capacity execution.

All unsuccessful attempts remain in the diagnostics receipt. In r6, identity,
gzip and zstd each delivered412,758,765 exact decoded bytes under the limits;
the harness then incorrectly rejected zstd's valid9,460-byte expansion. That
result remains failed, with zstd cancellation unexecuted. Independent source
review confirmed the correction retains exact encoding negotiation, real
bounded decoding, independent/source hashes, length, health, resource and
cancellation gates. Four tiny tests pass. The final unified six-case native
repeat remains pending; no hosted transport or broad-load success is claimed.

### November 4 — final exact-image HTTPS streaming qualification passed

The final six-case local run passed at source5787071 using observed HTTPS
registry image3a539c44, final gateway targetc1a25c41 with its exact one-worker
directive, and actual workspace-overlay mounts verified inside both containers.
Identity/gzip/zstd each delivered412,758,765 decoded bytes with independent and
upstream hashes, followed by successful2MiB cancellation and upstream quiescence.
All162 health checks passed. Peak cgroup memory: HTTPS25,833,472/134,217,728 bytes;
Nginx13,045,760/67,108,864; synthetic helper96,387,072/134,217,728. No OOM or swap.
Complete PID/FD/inode observation found36KiB HTTPS and4KiB Nginx allocated files.
All owned containers/network/private files were removed, source hashes unchanged.

Evidence: `https-api-streaming-20261104.json`, SHA
`a10f52cf769a39d1204354796039e0bb6147a7a3dfdee5bae63a1a4621aace72`.
The earlier failures remain preserved and adjudicated separately. Four focused
harness tests passed. This closes the selected local full-proxy streaming proof;
HTTP/2/3, concurrent/hosted load, public certificate renewal, production PVC
behavior and proposal600s acceptance remain separate gates. Transfer timings
include intentional slow-client pacing. The new gateway target is not claimed
already deployed; no product configuration or production records were changed.

### November 4 — final proxy proof uses the production worker count

The source binding now requires the final pinned-worker Gateway receipts and
exactly one declared and observed Nginx worker. The HTTPS qualification must also
record that same production directive without a worker-count transformation.
Prior disk receipts remain unchanged and retain their narrower fixture scope.
The release and runtime Gateway helper produce identical proof contracts; fault
checks reject automatic/multiple workers, boolean/string count coercion, and a
tmpfs filesystem presented as the qualified disk case.

All 13 pure release tests and 31 HTTPS guard tests passed. The source validators
also accepted the retained final Gateway and HTTPS native receipts: Gateway
configuration `c1a25c41…795ba`, routing receipt `8d395eec…e6014`, and HTTPS receipt
`a10f52cf…ace72`. [Binding evidence](evidence/final-proxy-proof-binding-20261104.json)
records exact hashes and the separate native-proof scope; this check itself did
not rerun containers or contact production. Hosted configuration, filesystem,
worker-count and process readback remain required during the reviewed rollout.

### November 4 — bind runtime publication to the actually qualified image

The runtime publisher now requires the frozen native image identity rather than
accepting a revision label and registry digest alone. Read-only inspection found
all 130 Dockerfile COPY files byte-identical to image `89afc8a31d76`, and recorded
all 146 `/app` tar entries with exact image permissions/owners, its 17 ordered
RootFS layers, complete runtime Config, pinned Deno base and three immutable
native proof receipts. Checkout Git file types/executable modes are checked
separately from umask-dependent permissions. The original Dockerfile was not
embedded; its retrospective recipe binding is explicitly limited.

[Qualification provenance](RUNTIME_QUALIFICATION_PROVENANCE.md) and the
[frozen receipt](evidence/runtime-qualification-89af-20261104.json) explain the
source closure and evidence chain. All 22 focused Python tests passed, including
source/path/mode/receipt/config/layer faults, existing-tag counterfeits, pending
publication and label-only promotion ordering. Actual local image/source checks
passed; no new native test, build, push or deployment ran. The publication binding
is deliberately null and blocks execution until the existing qualified image is
published unchanged and its observed immutable registry reference is recorded.
Promotion then permits only the revision label to change; ordered layers and
all other runtime configuration/labels must remain exact before any push.
Frontend/OCR build policy is unchanged. Final image publication/promotion,
release refreeze, cloud acceptance and model-quality gates remain separate.

### November 4 — refresh remaining actions and R0 at a7922ed

The remaining-action matrix and R0 index now retain all 51 earlier receipt
hashes and link 74 receipts. This documentation-only refresh records the actual
API 100-command capacity pass, retained 3,135-pass/two-failure full diagnostic
and 33-test correction, final pinned-worker gateway transport/routing proof,
explicit withdrawal of the earlier tmpfs fixture's disk claim, managed
read-only visibility/resource observations, integrated cutover race/guard
proofs, frozen reserve with ten constructible and 40 unsupported cases, and
unsuccessful LibreOffice refresh invocation.

No final full-green application, runtime promotion, refrozen release,
24-migration cloud restore, deployment or hosted acceptance is inferred.
The final HTTPS receipt and new OCR/promotion work were not ingested at this
anchor. Static verification checks every linked receipt hash and all nine
action/evidence mappings; no tests, provider calls or production operations
were performed by this refresh. Native document minimum margin remains
10.88 MiB; the index preserves each measurement's exact fixture/source limits.

### November 4 — freeze runtime promotion provenance and verify HTTPS temporary storage

The release manifest now binds the runtime qualification helper, immutable
89af image qualification receipt, and actual publication receipt/reference.
Missing or null publication blocks freezing; byte drift in any bound input
invalidates the manifest. This preserves the reviewed label-only promotion path
and does not equate a source revision label with a native-qualified filesystem.
The image helper separately verifies the full ordered layers and image
configuration at preparation and final selected-digest inspection. Canonical
migrations and existing receipt history are unchanged.

HTTPS now also checks that `/tmp` is a whole writable default-medium emptyDir
with at least the qualified configured size, then reads its actual filesystem
magic through a fixed `stat` command in each ready Pod before and after rollout.
Memory-backed, unknown, changed or partial mounts fail closed. The declaration is
not presented as a hard filesystem cap; no TLS-state content is read.

Local checks passed: 33 HTTPS boundary tests, 15 release/source tests, 15 updater
fault tests and 14 cloud-restore helper tests. The actual frozen runtime helper
and qualification artifact were read and its still-null publication correctly
refused at this check. [Evidence](evidence/runtime-manifest-and-https-disk-guards-20261104.json)
binds the local source/logs. Actual publication, final manifest, the renewed
isolated cloud drill, complete integration suites and hosted deployment remain
separate root-owned gates; no hosted operation was performed by these checks.

### November 4 — publish the unchanged qualified runtime and prove label-only promotion

The existing native-qualified image89af was published under immutable registry
reference `runtime@sha256:67fc1be0f574ea9b65e40408da436c3173fb4f332bb7729fe8da75e1ccaa4d28`,
pulled back by that digest, and verified against all qualified layers, platform,
Config and labels. The 130-file checkout/native evidence closure still matches.
The [publication binding](evidence/runtime-qualified-publication-20261104.json)
records the 29.186-second operation and removal of its temporary credentials.
No application workload, source filesystem or customer record was changed.

An actual local two-instruction FROM/LABEL promotion also passed with network and
pull disabled, retaining every ordered RootFS layer and runtime Config field and
changing only the source revision label. Its [receipt](evidence/runtime-label-promotion-20261104.json)
records the distinct resulting image ID and exact recipe; that local probe was
not pushed. This closes image identity/publication preparation without pretending
a metadata digest change is a new native capacity test. The 22 focused tests
remain source evidence; final source freeze, combined checks, isolated restore,
release promotion/rollout and hosted acceptance remain separate gates.

### November 4 — refreeze the complete 24-migration release from the original baseline

The manifest now contains all 24 reviewed migrations, the final one-worker
Gateway transport/routing chain, exact deployed HTTPS proof, shared Auth helper,
and the runtime qualification/publication binding. Canonical manifest SHA256:
`4cb2e712d4ce1b02a6b8bf907d78c78d968c9a27435b009842f6f48be46cff76`.
Source verification passed. Freeze used only the unchanged inner inventory
receipt from run41881660683; later capacity/visibility observations did not
replace that release baseline. Historical 22-migration restore results remain
limited to their original contract. The renewed exact 24-migration isolated
cloud restore and complete integrated package/ops checks are the next gates.
No schema or application deployment occurred during this local freeze.

### November 4 — complete operations gates on frozen 865d840

The complete required Python unittest discovery passed on exact source
`865d8406fcaf148299184bcbe67522fb0b256258`: 537 operations tests, 11
production-schema tests and 16 Kubernetes tests (564 total). Each suite exited
zero and reported `OK`; no failure or skip was reported. All tracked file hashes,
HEAD and the clean working-tree state matched before and after. The tested
canonical release manifest SHA-256 is
`4cb2e712d4ce1b02a6b8bf907d78c78d968c9a27435b009842f6f48be46cff76`.

[The retained receipt](evidence/final-operations-gates-865d840-20261104.json)
records exact commands, counts, source/manifest hashes and private-log hashes.
Tests ran alongside the separately owned application package suite, so elapsed
times are functional-test evidence rather than capacity measurements. This does
not claim completion of that package suite, the renewed hosted restore drill,
or deployment acceptance. No standalone native benchmark, provider request,
hosted mutation or workflow dispatch was performed by this check.

### November 4 — full application checks and exact 24-migration cloud restore pass

Both complete application packages passed at unchanged source
`865d8406fcaf148299184bcbe67522fb0b256258`: backend 3,284 tests across 193 files,
frontend 380 tests across 59 files, and typecheck/build for both. The
[package receipt](evidence/complete-app-checks-865d840-20261104.json) binds all six
commands, log hashes and the empty before/after source-map difference. Combined
with the separately recorded 564 Python gates, this is 4,228 passing tests.
Concurrent functional runs do not replace the retained native capacity proofs.

[Cloud restore run41933205779](https://github.com/salahassi/tenders/actions/runs/41933205779)
at the same exact source applied all 24 frozen migrations and passed all 13 actual
Auth/Storage HTTP checks using the shared application Auth policy. The
[receipt](evidence/cloud-restore-20261104-41933205779.json) binds canonical manifest
`4cb2e712d4ce1b02a6b8bf907d78c78d968c9a27435b009842f6f48be46cff76`,
original cluster CA/hostname verification and both successful cleanup stages.
No customer rows were copied, no providers called and no production business
records changed. Older 22-migration and fixture-policy receipts remain historical.
Application deployment, real saved-proposal/browser acceptance, provider semantic
qualification, Arabic OCR quality and Word field-update acceptance remain open.


### Final predeployment R0 refresh and actual target inspection — 2026-11-04

- Refreshed the remaining-action matrix and R0 discovery index at `8d970aa`, retaining all 74 prior receipt hashes and adding 15 source-specific receipts (89 total). Final manifest has 24 migrations, canonical SHA-256 `4cb2e712d4ce1b02a6b8bf907d78c78d968c9a27435b009842f6f48be46cff76`.
- Closed only the applicable local scopes: `865d840` backend 3,284/193 files, frontend 380/59, both types/builds; 537 operations + 11 schema + 16 Kubernetes; original-CA cloud restore 41933205779, all 13 Auth/Storage HTTP checks, 24 migrations and both cleanups. Runtime qualification, actual exact publication, local label-only promotion and final six-case HTTPS evidence are indexed separately from deployment.
- Preserved limits: DOCX minimum measured margin 10.88 MiB; previous false disk-medium claim withdrawn; official OCR candidate rejected (3/7 overall, 0/4 Arabic); reserve 10/50 canonical single requests with 40 unsupported/no provider outputs; actual Microsoft Word field update still open.
- Authorized read-only proposal inspection 41934185072 at `865d840` succeeded after missing encrypted-selection object 404 was retained and the unchanged 172-byte selection was re-uploaded/readback verified. Latest selected proposal remains blocked in analysis, with no active version/zero versions, one committed analysis result and 50 unknown usage rows. Cleanup passed; no model/retry/authorization/business mutation. Public evidence excludes customer identifiers/text.
- Supported next step after verified release requires fresh server-owned current-contract details and explicit canonical cancel+generate, retaining predecessor accepted results, pins, budgets and unknown accounting. Legacy whole-plan successor helper is unsuitable. No export completion or deployment is claimed by this documentation.
- Validation: all 89 indexed receipt files/hashes, unchanged prior hashes, action/evidence mappings, final manifest canonical hash and JSON parse checked; documentation-only changes, no package/native rerun.

### November 4 — real-DOCX byte-proof CI timeout correction

Automatic main verification [41934787660](https://github.com/salahassi/tenders/actions/runs/41934787660/job/126940409515)
at `2ac061349cb09ca796dc27a30de7450dbf4d5021` passed 3,283 backend tests and
failed only the first `deliveryByteProof.test.ts` case: 5,239 ms against Vitest's
5,000 ms default. The [retained evidence](evidence/delivery-byte-proof-ci-timeout-20261104.json)
binds the original complete CI log hash and exact failure. The release attempt
was canceled during verification before cluster access; no deployment occurred.

The five real-DOCX cases and their font/render setup now have an explicit bounded
30-second integration-test budget, matching neighboring DOCX integration tests.
All callback bodies and assertions are unchanged. The first case still calls
`deliveryBytes` four times and performs two real canonical archive verifications;
the proof-reuse, forged-receipt, changed-content/model, cancellation and immutable
snapshot checks remain intact. No product timeout, runtime source or native image
changed, and no verifier mock was added.

All five cases passed in three consecutive runs with one logical CPU and one
Vitest worker (15 executions), followed by backend typecheck/build. All 177
test/runtime/font/lockfile hashes were unchanged across those runs. These focused
functional checks do not replace the corrected complete GitHub CI gate, which
remains required before release.

### November 4 — bind manual storage retirement to actual captured processes

The separate manual retirement coordinator now requires the exact container IDs
captured before stopping workloads in both current and terminated status. It
rejects unknown/lost states, missing inner IDs, invalid or unordered timestamps
and exit codes outside the integer range 0–255. Its durable recovery journal
stores container names/IDs and the full exit proof. Recovery cannot adopt a
replacement container, an extra process, an older UID-only journal or a saved
proof for another identity. Initial identity and completed exit journals are
read back before Pod protection and finalizer removal, respectively; existing
compare-and-set checks, mixed-group retention and immediate-GC recovery remain.

[The correction receipt](evidence/storage-retirement-exit-proof-20261104.json)
retains four reproduced failures against merged source `2ac0613`, the corrected
rejections and 54 passing focused Python tests. It also discloses the initial
development failure and the existing eight local PostgreSQL authority tests
selected by an overly broad first test pattern. No hosted operation or physical
retirement was performed. Independent read review covered captured identity,
resumed processes, saved-proof validation and finalizer ordering.

This changes only the manual operations helper, tests and documentation. The
release workflow does not invoke that helper, its two Python modules are not
runtime image inputs or independently bound manifest fields, and all 24 canonical
migrations remain unchanged. Source verification still returns manifest
`4cb2e712d4ce1b02a6b8bf907d78c78d968c9a27435b009842f6f48be46cff76`;
no refreeze is required for this correction. Actual retirement must use the
corrected, reviewed workflow ref. Isolated hosted Kubernetes/PVC interruption and
recovery acceptance remains to be implemented and run separately. Whole-cluster
restore continuity and user-specified recovery-time/recovery-point objectives
remain unproved and undefined, respectively.

### November 4 — retain cancelled release and corrected follow-up gates

PR24 merged as `2ac061349cb09ca796dc27a30de7450dbf4d5021`. Release
[41934809173](https://github.com/salahassi/tenders/actions/runs/41934809173)
was deliberately cancelled during verification after the automatic main check
reported the retained DOCX test timeout. Cluster credential preparation, image
publication and schema/workload rollout were skipped; both cleanup steps passed.
[The receipt](evidence/release-cancelled-before-access-20261104-41934809173.json)
records this boundary, not a deployment. The action matrix/R0 retain all earlier
receipts plus the CI correction and strict manual retirement proof fix. Complete
corrected GitHub verification and actual deployment remain pending. Canonical24
manifest remains `4cb2e712d4ce1b02a6b8bf907d78c78d968c9a27435b009842f6f48be46cff76`.

### November 5 — repair validation retains the original task's source binding

Actual controlled execution of the frozen English/Arabic draft-repair cases
revealed a production defect: a valid quote correction failed with
`EVIDENCE_REFERENCE_INVALID` at `$.requirement_ids`. The recursive target validator
received the outer repair envelope, while draft source validation reads the
original task's source requirements. Direct original-task validation passed.

The narrow correction unwraps `original_context` only for that recursive target
validation, retaining the other options and all outer repair checks. It does not
copy requirements into the envelope, relax source or semantic validation, or
change provider policies. [The receipt](evidence/repair-original-source-context-20261105.json)
retains the two failed execution controls and a standalone baseline regression
with three failures/nine passes. After correction, 67 production source/repair
tests across six files pass, as do backend typecheck/build. A combined run with
the separately pending qualification controls passes 139 tests. Independent
source review found no remaining material blocker in the narrow correction.

The tests preserve faithful English/Arabic repairs, reject missing/different
original requirement bindings, invalid spans and changed reviewed conditions,
and prevent outer metadata from substituting for original requirements. Legacy
quote rejection and source-bound analysis tuple enforcement remain intact.
These are authored fixture controls, not provider semantic results. `model.ts`
is a runtime image input: the prior 89af image/source qualification cannot be
reused unchanged. A newly qualified runtime, release freeze and actual deployment
remain required; this local correction performs no provider or hosted operation.

### November 5 — expand frozen reserve construction without provider activation

The qualification adapters now construct 42 of 50 frozen cases: the prior ten,
22 workflow cases with source-reviewed authored prerequisites, four explicit
classification projections, four typed verifier phases and two narrow draft
quote repairs. Eight cases remain explicit composite/source-routing/repair-contract
boundaries. The fixed corpus, all 100 scheduled requests per model, source authority
and private-holdout requirements are unchanged. Four legacy `plan_proposal` cases
are labeled as legacy-task preparation rather than current hierarchical execution.

[The expanded adapter documentation](QUALIFICATION_RESERVE_ADAPTERS.md) and
[receipt](evidence/qualification-reserve-expanded-20261105.json) retain four frozen
prerequisite hashes, all case statuses, source maps and the original failed repair
controls. The controls exposed the separately committed production source-context
fix; the adapter does not manufacture outer requirements to work around it.
Actual request preparation and repair application now pass with immutable payment
prose, exact source visibility, canonical hashes/scopes and rejected caller callback
substitution. Source/semantic review stays pending; no model-authored approval or
prior accepted production stage is inferred from authored test prerequisites.

All 189 focused tests across five files pass (118 adapter controls plus 71 existing
reserve integrity checks), with backend typecheck/build and unchanged source hashes.
This commit changes qualification tools, fixtures, tests and documentation only;
no additional runtime image input changes beyond the separate source-context fix.
There were no actual provider/retrieval/database calls or production mutations.
Complete live semantic qualification, independent private holdout, approved
noncritical thresholds, eight unsupported cases and hosted acceptance remain open.

### November 5 — requalify the corrected runtime and keep publication pending

The corrected source `19498666b511a29c251923baa75bf42c88a0c6f0` was built as
`sha256:176bcf738676421ebc58d26cd7bc2a29910d0242635de6084129a06701a9e4f8`.
The new [qualification receipt](evidence/runtime-qualification-176bcf-20261105.json)
has SHA-256 `92b463d5cae58019b1dde7d235989638ee63e333ce21c23c824bf2f1a070ee68`.
It binds the observed build, all 130 copied files, 146 filesystem entries,
17 ordered layers, full runtime configuration and four new native receipts.
The pinned Deno base contributes the same ten-layer prefix. All earlier 89af
qualification, publication and native evidence files remain unchanged.

Sequential actual-image qualification passed two warm owned-snapshot downloads,
one fresh-parent repeat, the same reviewed DOCX artifact and the real local
PostgreSQL/PostgREST 100-command API stream, at unchanged 384 MiB/700m API limits.
The stream contains 100 ordered results, 412,758,765 bytes and 1,600 chunks in
56.703 seconds. The lowest observed memory margin is 17.21 MiB, from the warm
document run. These are fresh fixture measurements, not a causal improvement
claim or a hosted/concurrent capacity guarantee. No out-of-memory event or actual
swap occurred; the document harness relied on a zero-swap host rather than an
explicit no-swap flag. Source/fixture hashes and cleanup checks passed.

The [activity disclosure](evidence/native-orchestration-activity-scope-176bcf-20261105.json)
retains the four metadata tests near the warm-run end and their reported
0.002-second test-body duration; interpreter startup/import duration was not
measured. Normal metadata inspection and an isolated git commit also overlapped
the sequence. No receipt is described as having zero other processor activity.

Runtime qualification and release-manifest guards now pin only this exact new
image, receipt path and receipt hash. The separate
[new publication record](evidence/runtime-qualified-publication-176bcf-20261105.json)
has a null reference, so both release freezing and runtime promotion reject it
until actual push and immutable-digest readback. The older image's real registry
publication cannot satisfy the new identity. Publication, manifest refreeze from
the original deployment baseline, renewed restore and deployment remain pending.
This update performs no provider call, registry write or hosted mutation.

After the native window closed, all 22 focused qualification/image-promotion
tests and both focused manifest-binding/publication tests passed. Read-only
inspection verified the actual new image and complete checkout/native binding;
both pending-publication paths returned their expected errors. The
[guard verification receipt](evidence/runtime-guard-verification-176bcf-20261105.json)
also verifies seven historical evidence files byte for byte against `1949866`.

### November 5 — publish corrected qualified runtime and refreeze the release

The second release attempt [41937345060](https://github.com/salahassi/tenders/actions/runs/41937345060)
at `3c21a65` was cancelled during package verification after the canonical Arabic
and English repair controls exposed the real recursive source-context defect.
Cluster access, images and rollout were skipped; both cleanup steps passed.
[The retained receipt](evidence/release-cancelled-before-access-20261105-41937345060.json)
is not deployment evidence. The correction and four fresh native proofs are
recorded separately above; historical 89af measurements remain unchanged.

Exact qualified image `176bcf738676` was published, pulled back and verified at
`runtime@sha256:996e1ea5b3ff63ca4ea0e5ef75dc45c7d5a83f0c8a2501539bb0a8fc669fbfb2`.
[Publication evidence](evidence/runtime-qualified-publication-176bcf-20261105.json)
records 26.554 seconds and temporary credential removal. An actual local
[FROM/LABEL promotion](evidence/runtime-label-promotion-176bcf-20261105.json)
passed in 0.525 seconds with network/pull disabled and unchanged ordered layers
and runtime configuration except the revision label. That probe was not pushed.
No application workload or customer record changed during either operation.

The complete 24-migration manifest is refrozen to the corrected source, new
qualification/publication and unchanged final gateway/HTTPS proofs. Canonical
SHA-256: `2e6512d2eef73bc130f928cfcc01b04bcb437529cb5ab4b90fa815a228dce6fa`.
Only the original inner baseline receipt from run41881660683 was used. Source
verification passes. Complete integrated application/ops checks, renewed isolated
cloud restore, actual release and authenticated hosted acceptance remain required.

### November 5 — isolated interrupted-retirement qualification prepared

Added a separate two-job GitHub Actions qualification for the unchanged strict
manual retirement coordinator. The first job creates a nonce-owned database,
actual Auth/REST services and independent pinned Storage/gateway/synthetic-writer
Deployments on a new PVC. Genuine canonical application commands and a real
Storage upload leave an uncertain key with its cleanup reservation. The process
exits deliberately after durable original-container capture and scale-to-zero;
a fresh runner resumes from Kubernetes state, proves exact process exit and
physical/metadata absence, then checks canonical exactly-once quota release,
old-key denial, a new canonical upload and replica restoration.

The [qualification runbook](STORAGE_RETIREMENT_QUALIFICATION_RUNBOOK.md) specifies
ownership, original-CA access, current 24-migration manifest verification, private
proof storage, cross-attempt identity handling and verified PVC/database cleanup.
The fixed production adapter is neither imported nor retargeted. No provider
calls or production business rows are involved. The retained
[local qualification receipt](evidence/storage-retirement-isolated-local-20261105.json)
records 45 new Python checks, 3 fully migrated canonical SQL tests, 62 existing
retirement regressions, backend typechecking and syntax checks. Independent
source review identified a missing-helper cleanup retry and insufficient helper
process validation; both were corrected and covered by the new guards. No hosted
workflow has been dispatched. Initial allocation acknowledgment loss can require
ownership reconciliation; the intended durable interruption checkpoint is the
qualified recovery scope. Whole-cluster restore continuity, actual worker
capacity and user-defined recovery objectives remain open.

### November 4 — retain a bounded PaddleOCR feasibility proposal for A06

The [candidate assessment](ARABIC_OCR_PADDLE_FEASIBILITY.md) evaluates the official
mobile detector and Arabic v5 recognizer as a materially different local option.
Its [receipt](evidence/arabic-paddle-feasibility-20261104.json) retains immutable
source/model/package pins and verifies 23 recovered small source/metadata files.
Four core wheels alone declare 897,243,540 expanded bytes, before dependencies and
container overhead; the 768 MiB/one-CPU fit remains unmeasured. Upstream display
transformation and left-to-right box sorting leave logical mixed-script and Arabic
column order unresolved.

A fixed experiment is proposed with six newly authored and independently reviewed
pages plus all seven retained development controls. The candidate has not been
installed, run, adopted or deployed; no default, product limit, runtime image or
model-routing policy changed. The resumed checks are hash/arithmetic/document
validation only. No application or native tests were rerun for this documentation
change. Independent review remains required; the reviewer could not be spawned
because the agent-thread limit was reached. A06 and hosted acceptance remain open.

### November 5 — current-request operations helper and bounded issuance evidence

Added [the explicitly activated current-request workflow](../../.github/workflows/request-current-proposal.yml)
and [permanent operation reference](CURRENT_PROPOSAL_REQUEST_RUNBOOK.md). The
helper uses the deployed GenerationPanel buttons, genuine existing Owner Auth,
fresh server-owned details and exact canonical cancel-and-generate batch. The
encrypted exact body/key is read back before one send; stable predecessor
identity prevents a changed image or selection serialization from bypassing an
existing prepared marker. Original accepted results, frozen context, verifier
pins, budgets, checkpoints and unknown accounting are proven before/after.
Unknown transport never causes automatic resubmission.

The browser process is captured before any session/navigation, and detached
Chromium exits before driver cleanup on failure. Protocol input closes after its
terminal result. The read-only observer preserves actual accepted/deadline,
nullable persisted completion and effective timeout timestamps. It stops on the
first observed terminal error, preserves the original 600-second request clock,
and requires current generated draft/version/snapshot plus every ready volume
for recorded whole-package issuance. Blocking observations share a remaining
absolute watchdog budget; cleanup is separate. Actual file download and human
approval remain distinct evidence.

[Local source-hashed verification](evidence/current-proposal-request-local-20261105.json):
34 Python controls, 33 frontend-guard/exact-PGlite SQL cases, one selected
canonical generated-delivery/two-volume DOCX/observer case (17 other cases
explicitly unselected), and four real local Chromium/production-CLI lifecycle
controls passed. The browser controls verify one send, withheld acknowledgement,
forced driver death and terminal EOF; no browser absence is silently skipped.
The workflow installs the lockfile-pinned browser for this mandatory separate
gate. Both package types/builds and all frontend 380 tests/59 files passed.

The broader backend and operations runs on this older isolated base were
interrupted at the release owner's request before completion. Two backend cases
reported failures around their five-second default budget during concurrent
validation; their partial logs are retained rather than counted as passes.
Both affected cases subsequently passed a serial focused recheck using their
unchanged default budgets (two selected, 21 explicitly unselected); that does
not convert the interrupted full run into a passing suite.
No owned Node/Python process or fixture container remained after interruption;
the shared PostgreSQL fixture was untouched. The current integrated release
requires its own complete combined checks.

Implementation and focused local verification are ready for integration.
Deployment, explicit hosted activation, actual saved-proposal issuance outcome,
authenticated customer file acceptance and semantic quality acceptance remain
open. This change performs no activation, provider call, migration, billing,
capacity or unknown-usage mutation. Synthetic PGlite and local fixture HTML are
not native PostgreSQL, hosted Auth or deployed-frontend acceptance.

### November 5 — integrated evidence refresh, complete operations and renewed restore

The R0 discovery index and remaining-action matrix now bind integrated source
`2b869ac341f3ca7944247930e68c022f91a7383a`. All 92 prior receipt entries and hashes
remain unchanged; 17 new receipts bring the index to 109. The refresh includes
the production original-context repair correction, 42/50 constructible reserve
cases (eight unsupported, zero provider/retrieval/database requests), new
`176bcf` native/source qualification, exact `996e1ea5` publication, local
`c8b6db38` label-only promotion, manifest `2e6512d2`, prepared retirement/current
request helpers and both cancelled release boundaries. Runtime provenance now
distinguishes its historical pending-publication guard from the later completed
publication and manifest refreeze.

[Complete operations evidence](evidence/complete-operations-checks-2b869ac-20261105.json)
records 640 operations, 11 production-schema and 16 Kubernetes tests passing
(667 total), with all 539 source files unchanged. This exact-source result
precedes the forthcoming isolated-retirement cleanup correction and does not
qualify that later change. It does not replace the complete application gate.

[Restore run 41942455870](https://github.com/salahassi/tenders/actions/runs/41942455870)
at the same source passes all 13 actual Auth/Storage HTTP checks, all 24 additive
migrations from manifest `2e6512d2`, original cluster certificate/hostname
verification and both cleanup stages. Its [sanitized receipt](evidence/cloud-restore-20261105-41942455870.json)
was copied unchanged from the actual run evidence. A03 is closed only for this
isolated source/manifest scope. Synthetic data, zero copied customer rows and no
renderer execution do not establish production deployment, actual proposal
completion or recovery objectives.

Complete current application verification, relevant operations revalidation,
checked rollout, actual current-request activation and authenticated file
acceptance remain open at this refresh. Documentation validation checked JSON,
all 109 receipt paths/hashes, preservation of the 92 historical entries, action
mappings and the exact canonical manifest hash. No application/operations tests,
native runs, workflow dispatches or source changes occurred in this docs-only
refresh.

### November 5 — complete integrated application and operations gates at 2b869ac

All six package checks passed: backend 3,379 tests in 200 files, frontend 380
tests in 59 files, both type checks and builds. The harness recomputed its
source map and found no changed sources. The separate complete operations pass
is 640 operations + 11 production-schema + 16 Kubernetes tests: 4,426 total
functional tests across these application/operations scopes. Raw logs and
source-map hashes are bound by the public receipts; elapsed times are not native
capacity measurements.

The renewed original-CA cloud restore41942455870 at the same source passes
all13 Auth/Storage HTTP checks, all24 migrations, current manifest2e6512d2 and
both cleanup stages. The later isolated-retirement cleanup correction requires
its own source review/revalidation; it was not silently included in these runs.
Mandatory final GitHub verification, deployment, actual current-request
activation and authenticated complete-file acceptance remain pending.

### November 5 — preserve retirement cleanup proof across deleted resources

Independent review of the prepared drill found that a cleanup retry after
Deployment/PVC deletion tried to restore those deleted Deployments. The fixture
now persists and reads back the complete original termination journals and
protection-release proof before ordinary destructive cleanup. A new runner
validates that checkpoint and continues without re-adopting missing workloads.
Failures before any protection use a distinct exact-running-original witness;
that mode grants no process-exit or quota-retirement claim. Partial protection
with unknown exit still fails closed for reconciliation.

PVC cleanup now validates and durably records a new initial binding before
using that same observation's UID/resourceVersion for deletion. Missing/unbound
PVC recovery censuses volumes by the original claim UID; existing PV and
nonce/comment-bound database cleanup guards remain separate. The
[correction receipt](evidence/storage-retirement-cleanup-checkpoint-20261105.json)
records 57 passing focused Python tests, syntax/diff checks and independent
read review with no remaining material blocker. This is source-only evidence:
no hosted drill, production mutation, model call, runtime-image change or
canonical migration change occurred. An empty census after an unbound PVC is
gone does not settle in-flight external provisioning: that case retains state
and namespace for allocation reconciliation, without storage certification or
database cleanup. Earlier local receipts remain historical.

### November 5 — integrated cleanup follow-up and release readiness

Integrated the independently reviewed cleanup checkpoint and unproven-allocation
guards as `0cfb2ef`. Root repeated all57 isolated-retirement Python tests: passed.
The five changed/new fixture Python paths exactly match the new hashed receipt;
application, runtime, migration and image source remain byte-identical to the
complete `2b869ac` gate. Current manifest source verification still passes.
The public index now preserves all110 prior receipts and adds the scoped cleanup
receipt. Final GitHub verification, actual deployment and the isolated hosted
retirement drill remain distinct pending execution steps.

### November 5 — separate two-review reserve composites and remaining contracts

The qualification-only follow-up adds two independently pinned canonical review
requests for each English/Arabic review-identity case. The original single-request
entrypoint retains its 42/8 boundary. Combined offline construction now covers
44/50 cases: 100 logical cells per model remain scheduled; 88 are constructible
and require 92 physical requests, while 12 logical cells remain unsupported.
Version-one activation cannot represent this composition and remains explicitly
incompatible. No provider or retrieval request, billing/accounting mutation,
production source change, deployment or semantic pass follows.

Completed constituent outputs retain canonical source validation and hashes even
when a sibling fails. Incomplete composites have no success aggregate. Independent
source review caught asynchronous caller mutation that could relabel a case after
reconstruction; canonical identity and observation snapshots now remain stable
across awaits, with a regression control. A second reproduced projection defect
accepted the other frozen review's exact quotation when only the domain callback
ran; selected-evidence base validation now precedes it, matching the existing
production executor. The failing control remains retained. The
[follow-up design](QUALIFICATION_RESERVE_COMPOSITES.md) records exact remaining
work for scoped addendum inventory, explicit untrusted supplier planning inputs,
and deterministic quotation materialization versus identity repair dependencies.
Six English/Arabic controls reproduce those boundaries; they do not count as
passes of the six original semantic oracles.

All 229 focused tests across seven files, backend typecheck and build passed.
The 130-file source map remained unchanged during this final check. This includes
34 new composite controls, six boundary controls and 189 existing qualification
tests. Focused verification and source hashes are retained in
[the local receipt](evidence/qualification-review-composites-20261105.json).
Full current-source release gates, live composite execution, independent private
holdout, provider availability and semantic acceptance remain distinct.

### November 5 — current local gates and stopped hosted attempts

At `9501068`, all six application checks passed: 3,419 backend tests in202 files,
380 frontend tests in59 files, both type checks and builds, with unchanged
source maps. The source-resolution/worker5 changes are later work and require
new checks. The [receipt](evidence/complete-app-checks-9501068-20261105.json)
retains exact log hashes and scope.

Release41944374857 was deliberately canceled during source verification after
the canonical supersession diagnostic found a material old-obligation bypass.
Cluster access, image publication and deployment were skipped; both cleanup
steps succeeded. The diagnostic used authored false-positive verifier receipts
and issued a review draft only; it does not establish an actual provider false
pass or final-approval bypass. The [cancellation receipt](evidence/release-cancelled-before-access-20261105-41944374857.json)
preserves the run and exact source.

The first isolated hosted retirement attempt41946883085 passed57 fixture tests
but preparation failed with `RETIREMENT_FIXTURE_COMMAND_FAILED`. Deliberate
interruption was not reached and resume was skipped. Fixture cleanup verified
success and private runner files were removed. The [attempt receipt](evidence/storage-retirement-first-attempt-20261105-41946883085.json)
does not infer the underlying command failure: the old helper discarded that
diagnostic detail. A safe finite diagnostic is being added before retry.
### November 5 — first hosted retirement failure and safe command diagnostics

The first [isolated retirement run41946883085](https://github.com/salahassi/tenders/actions/runs/41946883085)
checked out `bc7afab77d02fb8cdcb591870e044317ad342977`. All57 fixture tests passed,
but prepare returned `RETIREMENT_FIXTURE_COMMAND_FAILED` before the deliberate
interruption. Owned fixture cleanup and runner-file cleanup succeeded; resume
was skipped. The full job log identifies neither the failing command nor its
output, so the underlying cause remains unproved. Successful cleanup does not
qualify interrupted retirement or prove which preparation phases completed.

Added fixed phase/command/exit/category diagnostics and an allowlisted envelope
for fixture-writer errors. Commands, payloads, private output, TLS verification,
ownership and cleanup authority are unchanged. The diagnostic boundary rejects
unrecognized/malformed metadata instead of publishing it. Focused local
verification ([scoped receipt](evidence/storage-retirement-failure-diagnostics-20261105.json)):
65 Python tests passed, including eight new failure-location,
privacy, timeout, child-envelope and cleanup controls. This change neither
reruns the hosted drill nor repairs an inferred infrastructure fault. Runtime,
application packages and canonical migrations are unaffected; no broad package
or provider test was run for this operations-only change.

### November 5 — second hosted retirement attempt now identifies the failed guard

Run41948742569 at2157dcf passed65 local guards, then stopped in
`canonical_fixture_write` with the recognized fixture error
`RETIREMENT_FIXTURE_REFRESH_MISSING`. Both cleanup steps passed and resume was
skipped. The [sanitized receipt](evidence/storage-retirement-second-attempt-20261105-41948742569.json)
locates the session-token validation failure without exposing token data.
Underlying format compatibility and its correction require verification; the
retirement acceptance gate remains open.
### November 5 — exact source-obligation resolution database contract

The isolated database correction adds `20261105120000_source_obligation_resolution.sql`.
It pins new predecessor review revisions without rewriting historical rows, keeps
raw passages, resolves exact typed units, validates pending as well as confirmed
requirements, and checks current generated artifacts and ordinary exports.
Analysis advancement independently verifies and stores retirement/current-unit
audits while preserving accepted analysis outputs. The existing current-request
user flow handles legacy refresh through `PROPOSAL_CURRENT_CONTRACT_REQUIRED`.
The strict restore scope and historical paid contexts remain intact.

Local focused verification passed 19 tests across the new source-resolution suite
and existing source-review restore suite. This includes real requirement INSERT,
real `advance_generation`, audit tampering, unchanged cabinets in a broad source,
revision and revocation controls, multi-source authority, 64 current reviews, and
canonical cancel/new-request commands. Source review aligned locator identity and marked-plan ambiguity rules with the
runtime. Final runtime/SQL integration and independent review remain required. Worker capability
five is owned by the separate following migration. No deployment or provider
inference occurred in this change. The contract and limitations are documented in
[SOURCE_OBLIGATION_RESOLUTION.md](SOURCE_OBLIGATION_RESOLUTION.md).
### November 5 — stop release for confirmed supersession inventory defect

The complete typed-review-to-export audit found a production inventory defect,
beyond the earlier unsupported reserve-adapter boundary. A human-superseded
nine-terminal requirement could be re-extracted as pending from the retained raw
source and reject a correct fourteen-terminal/three-cabinet response. Controlled
false-positive verifier records also reached an issued review-draft DOCX; final
approval remained blocked. The unchanged [baseline evidence](evidence/source-resolution-baseline-20261105/README.md)
records five passing counterexample controls, full source hashes and the limits
of the deliberately authored verifier records. Release `41944374857` at `bc7afab`
was canceled before rollout while this material issue was investigated.

The [versioned reviewed-unit repair](SOURCE_OBLIGATION_RESOLUTION.md) preserves
raw source and accepted analysis outputs, seeds current reviewed obligations,
retires only unambiguous exact typed units, and records source-bound dispositions.
Mixed/partial units require scoped resolution instead of silently entering the
active inventory. Runtime controls cover English and Arabic and retain the
separate arbitrary-prose false-verifier limitation. SQL persistence/export parity,
worker-five integration, complete source gates, deployment and live admission
remain required before this issue can be marked fully released. No reserve gold,
corpus, frozen qualification prompt or historical paid request was rewritten to pass the fixture.
### November 5 — isolated retirement refresh-token contract correction

The instrumented retry [41948742569](https://github.com/salahassi/tenders/actions/runs/41948742569) fails at `canonical_fixture_write` with the fixed child code `RETIREMENT_FIXTURE_REFRESH_MISSING`. The actual private token was not inspected. The pinned GoTrue v2.197.0 upstream implementation generates legitimate 12-character refresh tokens; the fixture client incorrectly required at least 20 characters in both session and persisted-state validation. Both now accept a nonempty bounded opaque string. Refresh HTTP success, UUID/role checks, the same actor after rotation, and private-state ownership and permissions remain enforced.

The [source-bound receipt](evidence/storage-retirement-refresh-contract-20261105.json) records the pinned upstream blob identities and 68 passing focused Python tests, including 12-character private-state roundtrip, malformed values, role/identity denial, failed refresh and changed-owner refusal before state writes. No hosted redispatch or production mutation occurred in this correction. The deliberate interruption/resume and physical retirement acceptance remain outstanding.
### November 5 — source-resolution worker capability boundary (in progress)

Fresh jobs now require worker capability5. The new claim/local-claim/wake RPCs
retain independent model protocol pins, render versions, lease controls and
provider accounting. The job trigger preserves every existing row at migration
and never lowers an already stored floor5 or future higher floor on update.
Current runtime entrypoints use capability5; historical RPCs remain present
and cannot claim new work. Wake checks apply the floor to queue, completed-job
and ready-local aliases, including accepted remote polling and handoffs.

Current-schema test/race/restore helpers use worker5 explicitly. Historical
migration-boundary tests and old-worker refusal controls keep their original
workers. At the intermediate patch,158 focused tests and38 admission/delay
controls passed; subsequent alias guards and new compatibility tests need
revalidation after the exclusive OCR measurement window. No full gate, new
runtime qualification, current manifest freeze, deployment or hosted request
acceptance is claimed by this work-in-progress change.

Focused worker5 verification now passes:120wake/contract/handoff tests in4files,
264mixed model/source/delivery tests in8files,158source/issuance controls in5files,
38admission/delay controls,9image guards,15update guards and18real atomic release
contract tests. These overlapping suites are not summed as unique tests. Backend
typecheck passes after linking both installed package dependencies in the
isolated worktree. The [focused receipt](evidence/worker-capability-five-focused-20261105.json)
retains log hashes, known iterative failures and final integration limits.

### November 5 — integrate source-resolution and worker5 release contracts

The upcoming release requires both new migrations,26total, source-resolution
version1 and worker capability5. Independent catalog guards require the source
review revision pin, requirement-resolution trigger and worker-floor trigger.
The isolated restore/retirement current-worker helpers use v5, while historical
24-migration hosted attempts retain their recorded v4 source. The old manifest
is intentionally retained until fresh native runtime qualification and exact
publication permit a reviewed re-freeze from the original baseline.
Integrated checks and deployment remain pending.

### November 5 — corrected source inventory reaches actual SQL and DOCX

The integrated runtime/SQL regression now issues a local Word review draft with
14 observation terminals and the unchanged3relay cabinets. The obsolete9-terminal
commitment is absent. Current artifact access is rejected with
`SOURCE_RESOLUTION_STALE` after later revocation. The independent analysis advance
also retains accepted analysis bytes and records the resolution audit. Two new
integration tests and the existing18delivery pipeline tests pass; the older
revocation fixture now refreshes authority-bound source blocks as well as reviews.
Authored verifier receipts remain fault injection, not a live-model accuracy proof.
No final approval, provider usage or deployment is claimed.

The completed [Paddle candidate campaign](evidence/paddle-ocr-candidate-rejected-20261105.json)
passed4of13whole-page controls and preserved2of21critical exact-quote facts.
All13pages plus the cold blank completed in159.956seconds; cleanup took8.707seconds.
The candidate is rejected for adoption, and the Arabic OCR acceptance gate remains
open. The [third retirement attempt](evidence/storage-retirement-third-attempt-20261105-41949704413.json)
failed at the broad retirement-capture phase with exit3; both cleanups passed.
Exact SQL localization is pending. Local non-superuser PostgreSQL tests now also
execute the isolated adapter's actual fence and census statements; all9authority
tests pass without changing grants or owners.

The26migration atomic release suite passes18tests in121.303seconds. The
[source-bound integration receipt](evidence/source-resolution-integrated-20261105.json)
records focused logs and exact changed-source hashes. Safe SQLSTATE diagnostics
from18fe844are integrated without exposing raw database messages.

### November 5 — final-suite findings and narrow compatibility correction

The e7e8ad4 full run passed3451backend tests and failed37across7files; frontend
380tests, both typechecks and both builds pass. Most failures were obsolete
fixture identifier validation and capability4expectations; the actual retry
wrapper also had an ambiguous `input` parameter beside `generation_steps.input`.
The full665operations suite found that retry defect plus the deliberately stale
runtime qualification binding, which requires a newly measured image.

Hosted retirement run41988242066 now identifies `retirement_prepare`/SQLSTATE42501;
both cleanups pass. Local PostgreSQL reproduces permission denial from
`to_regclass('storage.objects')` under a non-superuser application owner without
Storage schema USAGE. Replacing only those lookups with exact catalog OIDs passes
all25retirement controls with existing permissions. New migration20261105120200
also qualifies the retry parameter and preserves historical migration bytes.
The release set becomes27migrations. The permanent retirement suite now checks
this restricted owner profile explicitly. Focused corrected and final gates are
pending; deployment remains blocked.

Restricted-owner27SQL checks and3canonical operational retry tests pass after
the correction. The affected7backend suites reduced37failures to3obsolete
worker-floor expectations; those are corrected to5and their focused rerun is
pending. Independent release guards now reject the old catalog lookup and
unqualified retry parameter. Full runtime requalification remains pending.

### November5 — complete packages pass; new native image rejected for OOM

At f41adb8,3488backend and380frontend tests, both typechecks and builds pass with
unchanged source. The new721340runtime image fails its first frozen native Word
download with `DELIVERY_RENDER_FAILED`/HTTP503and container OOMKilled=true.
The parent remained alive to return the failure; the one-second sampling maximum
356745216bytes is not the exact peak. Sources/fixtures stayed unchanged and owned
containers were removed. Three later native suites were skipped; the image was
neither qualified, published nor deployed. The original rejection is retained in
[native-runtime-721340-rejected-20261105.json](evidence/native-runtime-721340-rejected-20261105.json).

The API verifier previously bounded only V8 old-space. The candidate correction
also bounds its young-generation semi-space to4MiB, preserving the64MiB old-space,
384MiB container, worker arguments, document oracle and deadlines. This targets
transient heap allocation; it is not an RSS guarantee and remains unqualified
until the same exact native fixtures pass. All35focused isolation tests and backend typecheck pass. New native
measurements are pending; no retry of the unchanged image is used as proof.

### November5 — complete current packages and new runtime qualification

Committed f41adb8 passes3488backend tests in206files and380frontend tests in59files,
with both typechecks/builds passing and no source changes during the complete run.
All18atomic27migration release controls,27restricted-owner retirement SQL checks,
11schema helper tests and16Kubernetes tests pass. Earlier e7e8ad4failures remain
recorded. Native imagef2d0f9 now has four fresh sequential receipts bound to the
current seven changed runtime files and added source-resolution module. Frozen
fixtures, base, build recipe and container limits are preserved. API child young-generation settings changed as documented after the rejected721340attempt; full package proof remains bound tof41adb8plus35focused isolation controls. Registry publication,
manifest re-freeze, fresh cloud drills and deployment remain pending.

Registry publicationf2d0f9 and27migration source verification pass. Manifest
canonical SHA256: `1fdf73f4a9b638938285afd13cbf3e4077e28da3932816ea80f9d03a6d748f82`. Fresh hosted acceptance is the next gate.

### November 5 — final operational integration and first27-migration restore guard

The complete operations suite runs665tests;664pass and one current-image metadata
expectation still assumed130files/146entries and the historical source revision.
The expected values now bind the observed131files/147entries and4b249ca source.
All13 focused runtime guards now pass.

Cloud restore41993470511 at4281235 validates the original cluster CA and passes
14local guards, then stops before catalog capture or fixture allocation with
`RESTORE_FINAL_SOURCE_CONTRACT_REQUIRED`. Its helper still required worker4.
The current gate now requires worker5, source resolution1 and all three new
migrations; focused negative controls cover old/future workers and missing
contracts. All15 focused restore guards pass. Both cleanup stages passed. A fresh hosted restore remains required;
this failure is not a certificate regression or an application rollout.

### November 5 — current27-migration cloud Auth/Storage restore passes

Run41993933795 atb933587 passes all13 actual Auth/Storage recovery checks and
both cleanups against manifest1fdf73f4. Original cluster CA verification and
15local guards pass. All27additive migrations were applied only to the isolated
fixture. No customer rows were copied, no model calls or production business
mutations occurred. The receipt preserves exact source/role-mapped migration
hashes. This proves isolated recovery, not rendering or application deployment.
The new interrupted retirement drill is running against the same source.

### November 5 — diagnose restoration without changing its authority or deadlines

Run 41994312853 at b933587 completes canonical fixture creation, retirement
prepare and the deliberate durable interruption. Resume fails with
`RETIREMENT_FIXTURE_SERVICE_RESTORATION_REQUIRED`; the separate cleanup and
private-runner-file removal both succeed. The aggregate error did not identify
the failed restoration stage and could mask an earlier coordinator exception.

The isolated adapter now retains bounded stage/workload labels, fixed error
categories and validated command diagnostics, including a sanitized prior error.
It still attempts every restoration and keeps the original identity, journal,
finalizer and readiness requirements. No arbitrary exception text is logged.
All 71 focused retirement tests pass, including fault injection proving that
other workloads are restored after failures and private data is excluded.
One instrumented hosted retry is next; no production deployment is claimed.

The R0 evidence index, remaining-action matrix and remaining-gates document now
include the 27-migration restore pass and the verified cleanup of the fifth
retirement attempt. Historical failures remain intact. The instrumented run
41996978998 uses 718ac68; no customer request or model call was started.

### November 5 — complete current operational suite passes

All 668 operations tests pass in 198.684 seconds on executable source 718ac68.
All 11 schema-helper and 16 Kubernetes-render tests also pass. The manifest
source check passes for all 27 migrations. Documentation was
reconciled in 0db4f0a during this run; executable/test source did not change.
This closes the earlier stale runtime-metadata failure. The mandatory final
GitHub gate and hosted retirement acceptance remain required before rollout.

### November 5 — isolate helper startup from original-writer process proof

Run 41996978998 at 718ac68 identifies the earlier failure as physical-helper
readiness timeout. Restoration then rejects its missing/invalid process identity
and times out on Storage readiness. Cleanup later succeeds. No Pod/event reason
was retained; missing identity does not prove that no process ever started.

The adapter now permits deletion of its exact UID/spec-bound helper after failed
startup, while all physical operations still require full process identity and
all original writers retain their independent journals and exit proofs. Cleanup
waits for the helper's deletion before restoring workloads. A failed readiness
wait additionally captures bounded Pod-state/event categories from the exact
owned UID, never raw messages, names or credentials. Timeouts are unchanged.
All 74 focused tests pass, including absent-identity cleanup, rejection of
foreign identity, private-event redaction and preservation of the initial error.
A new isolated trial is required to identify the initial startup cause; no
application deployment or customer invocation has occurred.

The permanent DO access runbook now directly names the interrupted-retirement
workflow, its original-CA path, nonce/PVC boundary, cleanup requirement and
fixture-worker limitations. This documentation change does not alter runtime,
manifest, cluster state or test outcomes.

### November 5 — retained fixture requires exact-origin inspection

Run 41999178689 at cac55b9 reports no prior coordinator error and no helper
cleanup error, but Storage rollout still times out. The later cleanup fails on
the same readiness condition; the nonce-owned fixture remains. This is not a
cleanup pass. No new fixture or deployment is authorized by this result.

The existing qualification workflow now has an explicit read-only inspection
mode fixed to that run, attempt and source. It verifies the namespace UID,
durable Secret identity, original manifest and deployment/ReplicaSet/Pod
lineage before reading status, events and bounded logs. Only fixed categories
and SQLSTATE values are public. It performs no cluster writes or SQL and
removes its own runner credentials. The original recovery authority is unchanged.
The initial helper-only 78 controls passed. The workflow integration then
exposed one stale two-job/no-input assertion; it now requires three definitions
with mutually exclusive inspection/allocation and rejects caller-supplied target
selectors. All 78 integrated controls pass after this correction. Current
fixture cleanup and release remain pending.

### November 5 — retained fixture removed; durable-resume phase corrected

Read-only run 42001827175 verifies the exact retained Storage Pod is ready and
records FailedMount events. Their detailed cause was not established. This
observation justified retrying only the failed job of run 41999178689. Attempt 2
rejects the durable retired phase in the old runner, then successfully completes
owned-resource cleanup and removes runner credentials. No fixture remains
reported by that cleanup; acceptance did not pass.

The runner now accepts interrupted or durably retired state. A retired state
requires its complete before/evidence/receipt/after record, and the unchanged
coordinator and verification still check canonical completion, accounting,
original process exits and restored replicas before client verification. Partial
records cannot enter recovery. All 80 focused controls pass. The prior 668-test
operational pass retains its earlier source scope. A fresh hosted trial of the
corrected recovery source is still required before application deployment.

### November 5 — isolated interrupted retirement passes

Run 42002971002 at e4192f9 passes deliberate interruption and all 13 actual
resume/verification checks against manifest 1fdf73f4. It observes original writer
exits, physical and metadata deletion, once-only allowance release and replay,
old-key HTTP denial, new canonical upload/read and physical absence/presence
after service restart. Resume and verification take 125.502 seconds in this
fixture. Both fixture cleanup and private runner-file cleanup pass.

This closes the isolated retirement gate only. The worker is an idle stand-in;
actual inflight upload, production fixed-target execution, production throughput
and a general recovery-time target are not established. Previous mount/readiness
failures remain recorded. No customer data, provider calls or production business
mutations occurred. The checked application release is the next step.

### November 5 — merged release application gates pass; cold-runner prerequisite fixed

PR28 merged as 5041a54. Release 42004407118 passes all 3,488 backend and 380
frontend tests, both typechecks and both builds. Operations runs 668 passing
tests but the nine authority tests cannot initialize because their immutable
PostgreSQL image is absent on the fresh runner. The tests deliberately use
`--pull=never` and `--network none`; they must not be skipped or silently change
binary. Cluster access, image publication and rollout are skipped; cleanups pass.

All 15 workflow entry points that run the full operations suite now explicitly
pull that same digest before the suite. The release and automatic verification
paths provision it before package checks to fail early if unavailable. A direct
registry pull confirms the exact digest, and all nine authority tests pass in
7.664 seconds. Application/runtime/migration bytes remain unchanged. A fresh
complete release gate remains required.

The merge-triggered duplicate credential-sync verification 42004363235 was
cancelled while still in package checks; discovery, binding and reload did not
run. The full mandatory release verification was preserved. No live model
evaluation or actual customer request was activated.

### November 5 — all final source checks pass; image metadata mismatch isolated

PR29 merged as bc5453f. Release 42008161260 passes 3,488 backend and 380 frontend
tests, both typechecks/builds, all 677 operations tests, 11 schema-helper and 16
Kubernetes checks. Original cluster CA verification passes. Image preparation
then stops with `RUNTIME_QUALIFICATION_CONFIG`; rollout is skipped and both
cleanups pass. No actual image-configuration difference was recorded, so its
cause remains unknown. The first cold-runner image prerequisite is resolved.

A separate inspection mode now pulls only the immutable qualified image and
reports identity/configuration-field comparisons without configuration values.
It cannot build, publish, migrate or roll out. The normal mode retains all
mandatory checks. All 12 focused image-helper tests pass, including private-value
redaction and mode separation. This diagnostic mode will identify the observed
difference before any change to qualification rules.

### November 5 — exact image bytes distinguished from Docker inspect defaults

Read-only run 42012896976 at af88b8d proves that image ID, filesystem layers,
platform and labels match the published qualified image. Runner Docker inspect
adds 11 configuration fields; it reports no missing or changed qualified field.
The unchanged raw config blob matches the qualification receipt locally and
its SHA-256 is the exact qualified image ID. No image or source rebuild is needed.

Runtime image inspection now reads that content-addressed config from a private
Docker save archive, verifies its SHA-256, platform and layer identity, and feeds
the unmodified raw config to the existing exact qualification guard. Both Docker
and OCI archive layouts are supported; missing, duplicate, symlink or tampered
config members fail. Nothing is extracted. Immutable-ID caching avoids repeated
large archives; private temporary files are removed.

All 31 focused controls pass. A real local image/promotion probe passes raw config
and unchanged-layer verification with only the revision label changed, without
registry writes or running containers; its temporary image is removed. The probe
binds the pending guard bytes by SHA-256 rather than claiming the base commit
already contains them. A fresh short hosted inspection and the normal complete
release gate remain required.

### November 5 — hosted raw-config verification passes

Read-only run 42014223667 at 533faeb passes original-CA access and the qualified
image guard using the SHA-256-verified config blob. Image ID, layers, platform,
labels and all config fields match, with no missing/added/changed fields.
Private credential/log cleanup passes. Explicit inspection mode skips package
checks, image build/publication, schema work and rollout; this is not a release.
The normal release mode still requires every complete check before deployment.

### November 5 — frontend image includes the shared browser source graph

Release 42014591057 at 9b54bad passes both application packages (3,488 backend
and 380 frontend tests, typechecks/builds), 686 operations, 11 schema-helper and
16 Kubernetes tests. Original-CA access and exact runtime promotion/publication
pass. The next image command fails; rollout is skipped and both cleanups pass.
The sanitized failure receipt preserves that boundary.

The old frontend-only Docker context reproduces TS2307 for sibling backend
shared imports locally. The Docker build now uses the repository-root layout
and a frontend-specific allowlist, preserving all 47 transitive shared source
modules and resolving their three browser dependencies from the existing locked
frontend installation. All six direct workflow callers and the release helper
use the same root context. The runtime Docker ignore file, qualified inputs and
package locks are unchanged. Fewer intermediate build layers avoid unnecessary
local VFS disk copies; only static output enters the final Nginx image.

The actual corrected linux/amd64 Docker build passes TypeScript and Vite, then
image metadata verification and owned tag cleanup. All 31 focused image/raw-config/
qualification controls pass; the exact frozen runtime source guard passes.
One prior local attempt exhausted development disk space before compilation;
owned probe caches and the rejected Paddle image/cache were removed while
retaining evidence and source. No containers or provider calls were started.
Receipts: `release-image-build-blocked-20261105-42014591057.json` and
`frontend-root-context-build-20261105.json`. A fresh complete hosted release and
actual customer request/export remain required; local build success is not rollout.

### November 5 — full CI and image publication pass; release preflight diagnosis

PR31 is merged at cc49d00. Release 42019256347 passes 3,488 backend and 380
frontend tests, both typechecks/builds, 686 operations, 11 schema-helper and
16 Kubernetes tests. All three exact-source runtime/frontend/OCR images publish
successfully. Deployment then reports only DELIVERY_UPDATE_FAILED; both cleanup
steps pass. Read-only inventory 42023050579 confirms all ten workloads ready,
previous application images and absent new delivery schema capabilities. It
does not prove that every pre-schema configuration was untouched. No actual
customer request was activated. Both receipts are retained in the R0 index.

The short explicit inspection mode now also runs the production resource,
Storage-gateway and HTTPS prerequisite guards without workload/schema writes
or a SQL client. It reports only fixed stages and validated guard codes. The
normal updater now preserves its typed gateway, HTTPS and runtime-qualification
errors instead of replacing them with the generic code. All 31 focused controls
pass (4 preflight, 15 updater, 12 image helper). Hosted diagnosis and a corrected
full release remain required; no qualification guard is relaxed.

### November 5 — read-only prerequisites pass; explicit rollback SQL diagnosis

Inspection 42023690528 at 4aca907 passes exact qualified runtime bytes and all
resource/gateway/HTTPS guards, with original CA and private cleanup. Comparing
post-release inventory to the original baseline shows gateway generation2→5
and Kubernetes revision2→3, while application images and routine-catalog hash
remain unchanged. This partial gateway transition must not be called a rollout.

A separately explicit `diagnose_schema=true` input now permits the frozen SQL
to run with its sole final NOTIFY/COMMIT replaced by ROLLBACK. It requires
inspection mode, preserves the entire guarded body and refuses any other
transaction shape. The helper compares the routine catalog before/after even
when SQL fails, emits only SQLSTATE/line and fixed outcomes, and verifies owned
SQL-client cleanup. The workflow also runs cleanup on failure. This operation
can take temporary database locks; it is rollback-only diagnosis, not read-only
inventory or an applied migration. All36 focused controls pass (5 SQL diagnosis,
4 preflight, 12 image, 15 updater). Actual schema diagnosis and release remain
pending; customer processing is still unactivated.

Rollback diagnosis 42024617445 at 23d6aee reproduces SQLSTATE P0001 at generated
line6330, the final release-contract assertion block. Before/after routine
catalog hashes match and both owned-client/private cleanup pass. The existing
images, resources and proxy prerequisites pass again. A bounded diagnostic now
allows only exact literal RAISE identifiers taken from the frozen SQL, never
raw error messages, to identify that assertion. The updater also retains only
SQLSTATE/line and fixed transport failures. All57 affected controls pass (6 SQL
diagnosis, 5 preflight/diagnostic, 15 updater, 31 deployment helper). A follow-up
rollback diagnosis is required; no production schema correction is claimed.

The source-allowlisted follow-up 42025233806 at 3e81848 identifies
DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED, with catalog restoration and both
cleanups passing. This is a real authority comparison rejection, not a reason
to remove the guard. Rollback diagnosis now adds a bounded notice immediately
before that unchanged rejection: changed metadata sections, baseline function
signatures/field names, and only fixed application-role ACL entries. Unknown
role entries are redacted; no owners/configuration values/policy bodies/customer
rows are emitted. Seven SQL-diagnosis and31 deployment-helper controls pass;
a real PGlite synthetic SQL probe verifies notice syntax and the preserved
P0001 rejection. Exact authority differences remain to be observed.

Authority-notice run42026259554 retains the same rejection and verified
rollback/cleanup, but produces no accepted authority projection. The parser is
now corrected to accept PostgreSQL's visible public-function signatures without
an explicit public schema prefix, and the diagnostic transaction requests
notices locally with a separate notice-present flag. Seven focused controls
pass. The first local PGlite probe failed to collect the notice because its
callback was passed to the constructor; the corrected exec callback probe
passes and preserves the same SQL rejection. No missing hosted metadata is
inferred from either local probe; the next hosted observation remains required.

### November 5 — preserve the two pre-existing service EXECUTE grants

Rollback run42026869332 at ee0f272 identifies exactly two ACL changes:
artifact_context(uuid) and workspace_status() lost tdp_app_service EXECUTE.
No owner, definer, configuration, table/column, policy, role or membership
difference is reported. The routine catalog is restored and both cleanups pass.
The original authority guard is correct and remains unchanged.

The two still-unreleased migration permission blocks now snapshot only explicit
service-role EXECUTE grants from their renamed predecessors before revocation,
then restore those exact grants/options on the checked canonical wrappers.
Missing grants remain missing; predecessors remain private; an unreviewed
grantor fails closed. Capture and restoration occur in the same DO block,
without session settings, extra schema objects or cross-statement state.

Actual isolated PostgreSQL passes14 scenarios in2 test methods, covering both
role families, no grant, grant, grant option and unsupported grantor. Targeted
backend migration/ordinary export suites pass28 tests. Release guards pass18,
schema diagnosis7, native qualification13 and restore guards15. The exact native
source guard passes unchanged. The27-migration manifest is refrozen from the
original baseline at ada21f57461fa81e3b45778685d86438117ef419ad8c31ceaac86c06dcb2dba3.
Receipts retain the pending input hashes, earlier failures and original baseline.
Full rollback diagnosis, current-manifest cloud restore/retirement, final release
and actual issuance remain pending; no customer processing has started.

### November 5 — current-manifest rollback, restore and interrupted retirement pass

At6c469c5 and manifestada21f57, rollback run42028955332 passes the exact complete
frozen SQL and every release guard, restores the original catalog and cleans up.
Cloud restore42029295368 passes all13 actual Auth/Storage checks and both
cleanups. Interrupted retirement42029747879 passes all13 actual checks, owned
fixture cleanup and both runner cleanups. It still uses an idle fixture writer;
no inflight PUT, production adapter or general recovery objective is claimed.
Receipts are indexed separately from the earlier1fdf73f4-manifest passes.

The release prerequisites are now renewed. Application rollout remains
incomplete until the mandatory full release gate, exact image/schema readback
and public checks pass. No actual customer request or provider campaign has run.

### November 5 — application release passes at8874111

[Release42031298536](https://github.com/salahassi/tenders/actions/runs/42031298536)
passes the complete package and operational checks, all three image publications,
atomic schema, compatible workload rollout and exact final readback. The final
catalog hash is8f82c88194713bff62224f307d8ab6744a42f4d7fa57a3559fafc4d083cddc04.
Worker/API/source-browser/scheduler use runtime9a94ce1a; frontend32f26e92 and
native OCR15519127 are verified. Old workers and gateway processes are drained;
both cleanup steps pass. No historical processing was explicitly retried.
The sanitized receipt retains exact images, schema, resource/configuration
evidence and scope. Authenticated customer issuance/export remain separate.

### November 5 — current request starts; early no-agent failure and observer correction

The deployed application accepted one canonical cancel-and-generate request.
Its original 600-second deadline is retained; the exact successor failed early
with `AI_AGENTS_UNAVAILABLE` and no issued version. The initial browser harness
returned unknown because its hand-built fixture assumed the captured response
already contained the issuance ID. The actual admission trigger binds that ID
after the command captures its result. The fully migrated SQL regression now
consumes the real saved wire chunks and reproduces the old guard failure before
passing the correction. Database history, exact successor, actor, operation and
clock checks remain mandatory. No durable marker was bypassed and no second
business request was sent. The read-only inspector adds issuance clocks without
calling commands, providers or scheduler functions. See the linked current
followup receipt for private report hashes, cleanup and separate evidence limits.

Read-only followup [42037659578](https://github.com/salahassi/tenders/actions/runs/42037659578)
at `a4a3e9583172452248e174a84d6e4931037979fc` confirms the exact original issuance
ID/actor/plan/accepted/deadline tuple, deployed runtime, zero proposal versions
and persisted `AI_AGENTS_UNAVAILABLE` closure after **60.658012 seconds**.
The 600-second deadline was neither reset nor reached. Original-CA access and
cleanup passed. All 3,491 backend tests / 206 files, typecheck and build pass on
that source. This followup changes operational observation and documentation;
production runtime/schema bytes are unchanged, so no replacement deployment or
second business request is performed.
