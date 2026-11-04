# Native API batch capacity qualification

`api_batch_capacity.py` qualifies the actual API handler and `Backend.batchStream`
against real local PostgreSQL and pinned PostgREST. It uses the same synthetic
fixture as `upstream_batch_capacity.py`: permitted structural rows are seeded,
then actual authorized `export.prepare` creates a roughly 4.13 MB serialized
snapshot. Its physical compressed row is much smaller. This fixture does not
prove generation-writer reachability or managed PostgreSQL resource capacity.

The coordinator runs one exact immutable application image at the reviewed API
384 MiB / 700m limit, with the image's entrypoint and default V8 heap settings.
Its command explicitly replaces `scripts/runtime/main.ts` with the qualification
harness. That harness loads the same API/worker/browser/scheduler module graph,
then invokes the actual handler. Only Auth user lookup is synthetic. Membership,
revision checks, commands and chunk access use the actual caller JWT and migrated
SQL. A real loopback HTTP adapter removes `/rest/v1` before forwarding to bare
PostgREST. This is not production Auth, Nginx or hosted acceptance.

One batch renews the authorized export 100 times. The consumer hashes each result
according to its immutable descriptor length, comparing every byte/hash and the
final database command snapshots. It never parses or retains the aggregate JSON.
It also pauses before consuming result bytes, checks retryable busy admission,
finishes the full stream, and replays the same key before canceling after the
first real chunk settles. The cancellation control checks no later chunk reads
and heavy-lane reacquisition; it does not claim to interrupt in-flight SQL.
Final revision, audit, command and batch counts reject extra mutation on replay.

```sh
python3 backend/scripts/testing/api_batch_capacity.py \
  --image sha256:89afc8a31d76e1616ad17e5896e0fc54f0acdc41cd7da389af456386f3e998fe \
  --output /workspace/output/api-batch-capacity-unique
```

Run only in an explicitly coordinated native measurement window. The script
requires the pinned images already cached, creates only nonce-labelled local
containers, publishes no port, and removes only containers it owns. The output
path must be new. Receipt hashes bind the harness, SQL, and actual image source;
negative outcomes and cleanup are retained. The full request has a 150-second
measurement ceiling and the coordinator a bounded 210-second API process wait.
This is a capacity fixture, not a promise of production throughput or the
proposal-issuance service level.

The five pure `batchStreamOracle.test.ts` cases verify split UTF-8/framing and
reject altered, truncated, extra or reformatted bytes. Native results are a
separate gate and must not be inferred from these tests.

The actual run on root `6a73cafc0933723f6441a9b448d49443200d37ad` passed. Its
[receipt](evidence/native-api-batch-capacity-20261104.json) binds the final batch
INSERT fence, unchanged harness/SQL sources and actual immutable image files.
The 100 results produced 412,758,765 response bytes, including the API envelope,
in 58.024 seconds; headers arrived after 6.140 seconds. Every descriptor and SQL
snapshot hash matched. The 1,600 stored chunks represented exactly 100 mutations;
same-key replay/cancellation added no revision, audit, command or batch writes.
Both EOF and settled-chunk cancellation released heavy admission; paused response
consumption returned retryable busy without reaching heavy database work.

API cgroup peak was 163,995,648 / 402,653,184 bytes, with no max/OOM/kill events.
The sampled process RSS peak was 208,576,512 bytes; RSS and cgroup accounting are
different observations and must not be combined into a universal headroom claim.
PostgreSQL/PostgREST peaks were 184,496,128 / 49,012,736 bytes under their separate
local fences. Health completed 114 times. All three owned containers were removed.
This closes this one integrated native batch fixture, not hosted Auth, cold-start,
concurrent-load, arbitrary result-size, browser aggregate parsing, or proposal
issuance service-level qualification.
