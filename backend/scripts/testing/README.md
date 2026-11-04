# Isolated PostgreSQL concurrency checks

`postgres_races.py` uses real PostgreSQL 17.6 with independent `psql` sessions.
It applies every migration from the selected repository to a fresh database,
using the same minimal Auth/Storage stubs as the PGlite tests. Fixtures are
synthetic. It never connects to a hosted database or calls a model, storage
service or production API.

From the repository root:

```sh
python3 backend/scripts/testing/postgres_races.py --receipt /tmp/delivery-races.json
```

The Docker image has a pinned digest. The container uses `--network none`, no
published ports and a temporary in-memory data directory. It is removed after
execution unless `--keep-container` is given. Docker must use the local socket;
remote Docker selectors are cleared for daemon-management commands. The receipt
contains only test outcomes, synthetic identifiers, image and migration hashes.

The delivery suite checks concurrent idempotent prepare, the early generation
base, concurrently accepted siblings, a human edit competing with refresh, and
source/membership changes competing with replay. Contenders must be observed
waiting in `pg_stat_activity` before the lock holder commits; elapsed time alone
does not establish a race. Accepted-unit fixtures inject already accepted graph
results, so these cases prove publication and preservation, not AI correctness.

To share an isolated container between suites, retain it and use a fresh named
database for each suite:

```sh
python3 backend/scripts/testing/postgres_races.py --keep-container
python3 backend/scripts/testing/postgres_races.py --container tdp-races-PRINTED --database races_integrated --repository /path/to/integrated/repository
```

`PostgresFixture` can also be imported by adjacent Python suites. Its `sql`,
`value`, `command`, `command_sql` and `race(statements, before_release="")`
helpers use independent sessions. `start()` requires a fresh `races_*` database
and refuses network-exposed containers. `workspace` and `OWNER` identify only
the synthetic fixture. A script attached to an existing container does not own
its lifecycle. Remove the retained container after all attached suites finish:

```sh
docker --host=unix:///var/run/docker.sock rm -f tdp-races-PRINTED
```

These checks complement the normal Vitest suites. They do not exercise live
Supabase Auth/Storage, the server renderer, Word layout or deployment.

`delivery_artifact_races.py` exercises durable local export receipts with the same
isolated harness: identical and conflicting receipt commits, current source and
membership revocation, cancellation, and competing document/artifact capacity
reservations, plus competing explicit initialization of a snapshot saved before
the artifact queue existed. It observes real database lock waits before releasing
each race.

```sh
python3 backend/scripts/testing/delivery_artifact_races.py --output /tmp/artifact-races.json
```

Trusted-worker hash/size receipts in SQL tests are synthetic. Canonical DOCX
validation and real storage bytes are tested separately by the renderer suite.
