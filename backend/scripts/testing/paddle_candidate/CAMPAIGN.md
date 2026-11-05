# Frozen external campaign coordinator

These scripts prepare and orchestrate an isolated experiment. They have not
executed OCR. The root coordinator must first review the exact final image,
configuration, parent/engine/coordinator hashes and open an exclusive native
window. `make_campaign_binding.py` writes a reviewable binding; it does not grant
that authorization. Do not use a temporary or anticipated image identity.

`campaign-sources.json` contains only source paths, hashes, page/count/language
and stable case identifiers. Its 13 cases are the six prospective frozen pages
followed by seven unchanged development controls. A separate fresh-process cold
blank precedes them; that additional attempt is excluded from the denominator
of 13. The source mapping was derived before any candidate output from gold SHA
`c5ca3a7cc0ccb72eeb52e47dce2bac2429c92c47908c45aa63ea29da618fd735`.

The only candidate input mount contains `source.pdf` and `request.json` with
`original_hash`, `page`, `total_pages`, `language`. No gold, expected text,
normalization oracle, evaluation code or whole repository is mounted. A separate
read-only gate mount contains the stdlib gate and host-created start sentinel.
The container has no network, a read-only filesystem, a 256 MiB `/tmp` tmpfs,
no capabilities, no new privileges and UID/GID 1000. Its explicit limits are one
CPU, 805306368 bytes memory, zero swap and 128 PIDs. Docker proxy defaults are
overridden with empty per-container values for this offline run; global Docker
configuration and host proxy/CA settings are unchanged.

Before the cold attempt and every Docker create, both output and actual Docker
storage filesystems must have at least `max(4 GiB, 2 * actual image logical size
+ 512 MiB)` free. This conservative VFS guard follows a retained preparation
create failure even with 2.624 GB free; it is not an inferred installed footprint
or a permission to delete retained images. Insufficient space stops before
container creation and remains a blocked/failed attempt with no OCR output.

Each fresh container first runs `entry_gate.py`. Before releasing Node, the
host verifies actual `memory.max`, `memory.swap.max`, `cpu.max` both through the
gate receipt and the host cgroup reached through the exact inspected Docker ID.
It uses the established `upstream_batch_capacity.Monitor` layout,
`/sys/fs/cgroup/docker/<64-hex-container-ID>`, with the observed VFS storage,
`cgroupfs` driver and cgroup v2 explicitly checked and retained. It validates the
exact container image/owner, running host PID and that PID's actual membership
in `cgroup.procs`, including another membership check immediately before Node
release. Missing directories, unsupported layouts, symlink redirection,
identity mismatches or changed resource controls fail closed. It
also checks actual in-image configuration/parent/engine hashes. The gate then
execs Node with `--experimental-transform-types`, matching the existing parent
runtime. Node and its native child must report the same cgroup, and the child's
parent PID must equal Node's PID. The engine receives the original frozen
settings, not per-language or output-dependent tuning.

The first approved November 5 attempt stopped before Node release because the
old resolver joined a namespace-relative proc path to the host cgroup mount and
rejected the resulting `/sys/fs/docker/...` path. The original attempt did not
retain the raw proc string; its exact value is therefore unknown. That failure,
its original binding, all 13 not-run rows and positive cleanup remain unchanged.
The corrected resolver retains raw `/proc/<host-PID>/cgroup` diagnostics before
resolution validation, including on failure, but never uses that string as a
filesystem path. Relative `../docker/<ID>` and absolute `/docker/<ID>` forms are
checked against the inspected ID; both resolve through the same fixed Docker-ID
host layout. Source-only namespace tests cover these forms and rejection cases.
This correction changes no model, configuration, fixture or acceptance oracle;
it requires a new root-reviewed binding and execution window before retry.

The external monotonic deadline is 90 seconds per attempt, beginning before
staging, Docker creation and startup. An owned POSIX interval timer interrupts
synchronous host reads, hashing and copying as well as subprocess waits. It
cannot be reset by Node or Python. The cold attempt plus 13 page attempts have
a 1260-second global work bound; after the cold attempt, an additional
1170-second campaign wall deadline applies to the 13 pages and their cleanup.
Cleanup and artifact hashing have a cumulative 120-second
allowance, with each removal bounded to at most 20 seconds and the whole run
bounded to 1380 seconds. Each Docker CLI call has a timeout clipped to the
remaining absolute budget; background log/wait CLIs are killed and reaped in
cleanup. Cleanup between attempts also consumes elapsed global work time,
making the limit stricter than 14 unrestricted 90-second attempts. A fresh
source/hash and binding drift check occurs before/after the campaign, and
sources are rehashed immediately before each attempt.

The host samples cgroup current/peak/events every 200 ms after Node release,
records timestamped Docker stdout/stderr, and retains Docker state/OOM status.
These external samples alone are lower bounds: a final peak can occur before
cgroup deletion between polls. Therefore success additionally requires the
surviving Node parent's final `cgroup_final` receipt, with memory peak within
the cap, zero swap and no memory-limit/OOM events. Its scope is the final
before-exit observation, not a measurement after the process has exited. A
missing final receipt cannot pass capacity. Host polling/orchestration itself
consumes CPU; no claim of zero other host CPU activity is made. These scripts
cannot guarantee wall-clock behavior under a stalled host/kernel/filesystem;
they retain any observed outer-budget violation as failure.

Cleanup removes only a container with this run's unique owner label, verifies
its absence and records commands/status. A timed-out Docker create leaves
daemon completion unknown: an immediate empty listing is retained as an
observation and cannot establish cleanup. It requires acknowledged creation or
owned removal and confirmed absence; otherwise cleanup remains unknown/failed.
It never prunes images or touches
other containers. A timeout, memory event, malformed/missing output, effective
configuration drift, missing final capacity evidence, failed cleanup or
non-empty cold blank stops the campaign. Remaining cases retain `not_run`
rows. A later page's text mismatch is retained without stopping or tuning;
the coordinator has no oracle with which to make that decision.

After the final image and files are stable, prepare the binding, review its
printed SHA-256 with the root coordinator, and then use these commands only in
the authorized native window (replace the explicit placeholders):

```sh
python3 make_campaign_binding.py \
  --image-id sha256:EXACT_FINAL_IMAGE_ID \
  --experiment-directory /absolute/frozen/experiment/files \
  --root-window-reference EXACT_ROOT_AUTHORIZED_WINDOW_REFERENCE \
  --output /absolute/new-output/run-binding.json

python3 run_campaign.py \
  --binding /absolute/new-output/run-binding.json \
  --expected-binding-sha256 EXACT_REVIEWED_BINDING_SHA256 \
  --source-root /absolute/frozen/source/checkout \
  --config /absolute/frozen/experiment/files/experiment-config.json \
  --output /absolute/unique-campaign-output
```

No Docker command is run by the binding generator. The actual coordinator
requires a new output directory and an exact immutable local image ID, never
a mutable tag. Its gate validates that the approved host file hashes are also
the actual image contents before Node can start.

After the campaign has finished or stopped, evaluate outputs on the host:

```sh
python3 evaluate_campaign.py \
  --campaign /absolute/unique-campaign-output \
  --gold /absolute/frozen/fixtures/gold-manifest.json \
  --oracle /absolute/frozen/fixtures/oracle.py \
  --output /absolute/unique-campaign-output/host-evaluation.json
```

The evaluator's own source hash is frozen in the pre-output binding. It verifies
gold/oracle hashes and receipt/raw-output/projection hashes, uses only the
predeclared NFC/whitespace normalization, and reports all
13 denominators. It reports whole-page exactness and the prospective pages'
separately authored exact critical quotes, including their order where that
is part of the quote. Historical controls have only their existing whole-page
oracle; no new semantic acceptance is invented after recognition. Output is
never repaired, reversed, reordered or relabeled correct. Unmodified upstream
`rec_texts` joined with newlines and Node's trimmed projection are scored
separately; both must pass, so a character such as FEFF removed only by JavaScript
trim cannot disappear from the upstream comparison. Failed/not-run
attempts cannot pass. Even a finite 13/13 result would not establish universal
correctness, private/human holdout performance or production suitability.

The stdlib unit tests use synthetic byte strings and mocked subprocesses. They
check deadlines, actual control drift, source/gold separation, byte/path drift,
owner-safe cleanup, native process/cgroup evidence and final memory receipts.
They establish coordinator guard behavior only, not Docker/native readiness:

```sh
python3 -m unittest -v test_campaign.py
```
