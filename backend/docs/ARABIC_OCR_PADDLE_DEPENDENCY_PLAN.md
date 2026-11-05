# Paddle mobile experiment: dependency and offline build plan

The retained metadata pins four candidate wheels and two model revisions. It
does **not** contain a complete transitive dependency lock, a prepared runtime
base, verified downloaded wheels/weights, or measured installation size. This
plan introduces no installation, native import, recognition run, provider call,
or production change. The six new gold pages are prepared separately and must
be frozen and independently reviewed before any recognizer output.

The source-only package is in
[`scripts/testing/paddle_candidate`](../scripts/testing/paddle_candidate/).
`seed-manifest.json` retains each exact official wheel URL, filename, version,
size, SHA-256 digest and published dependency declarations, including their
environment markers. `requirements.seed.in` is a resolver input, **not** an
installation lock. `freeze_lock.py` converts a later target-native pip report
into one hash per selected wheel without importing an OCR package. Its output
explicitly remains unverified until offline dependency closure and byte checks
pass. It refuses changed root pins, an incorrect target, source archives,
non-PyPI wheel hosts, missing hashes, duplicate/yanked packages and overwriting.

## Candidate pins and unresolved closure

The candidate is CPython 3.11 on Linux x86-64 with glibc, PaddleOCR 3.7.0,
PaddleX 3.7.0 with only its `ocr-core` extra, PaddlePaddle 3.2.0 CPU and
`opencv-contrib-python` 4.10.0.84. The wheel hashes are already recorded in
[the feasibility evidence](evidence/arabic-paddle-feasibility-20261104.json).
The selected model repositories are:

- `PaddlePaddle/PP-OCRv5_mobile_det` at `0d63e78e2b680928f6b1747d76a08db6e645efb7`.
- `PaddlePaddle/arabic_PP-OCRv5_mobile_rec` at `33d91636a65dca87f5562cc48860332ae367ee1b`.

Both model cards declare Apache 2.0. The seed records the exact large-file SHA-256
digests and known configuration-file hashes. Each graph JSON has an immutable
Git blob SHA-1 and revision pin, but its SHA-256 is still missing. Fetch only
those exact revisions, verify the Git blob identity (`SHA1("blob " + byte_count +
NUL + bytes)`), and record SHA-256 before the experiment. Actual graph, parameter
and configuration bytes, sizes and licenses must all be checked; no mutable
`main` model URL or automatic runtime download is allowed.

PaddleX unconditionally requires `aistudio-sdk`, `huggingface-hub`, `modelscope`,
NumPy, Pandas, Pillow, Pydantic and other packages. Its `ocr-core` extra adds
`imagesize`, OpenCV, `pyclipper`, `pypdfium2`, `python-bidi` and Shapely. PaddlePaddle
adds `httpx`, Protobuf, `opt-einsum==3.3.0`, NetworkX and SafeTensors. PaddleOCR
adds `aiohttp`, requests and typing extensions. PaddleX requires
`PyYAML==6.0.2`; NumPy's applicable intersection includes `>=1.24,<2.4`.
These are requirements, not a resolved package list. Their transitive versions,
wheels, platform markers and hashes are not available in the retained four
package indexes. Omitting client libraries or using `--no-deps` at installation
would not establish a complete supported environment. Do not add the `all`,
`ocr`, training, GPU or high-performance extras to this candidate.

The known four-wheel size is 260,054,611 compressed bytes and 897,243,540 declared
expanded bytes. Model runtime files add 13,070,333 bytes. These are lower bounds,
not disk reservations or memory requirements. A fresh resource check must include
all selected wheels, extraction, models, interpreter, Node parent, native system
libraries, package caches, image layers and the Docker storage driver. Host
`/tmp` is memory-backed; it is not interchangeable with workspace disk.

## Exact preparation sequence for the later execution window

No commands in this section have been run for this candidate. First prepare and
record an immutable experimental base containing CPython 3.11, the exact pip
version, the existing Node 24 parent dependencies, Poppler where the parent
requires it, and the actual dynamic libraries needed by the selected wheels.
Record its digest and complete native package/library inventory. The existing
Node base is pinned by `backend/deploy/Dockerfile.ocr`; it does not prove that
Python or the Paddle/OpenCV native dependencies are present. Do not infer required
libraries from package names or install an unversioned apt set. Missing shared
libraries, glibc incompatibility or an unsupported CPU instruction are failures
to investigate, not grounds to substitute another engine silently.

Run resolution inside that exact Linux x86-64 CPython 3.11 environment with a
fresh private output directory. Preserve its command, base identity, Python/pip
versions and target environment along with the JSON report. Network resolution
may download wheels when metadata-only resolution is unavailable, so it belongs
in the later disk-approved preparation window, not this metadata task:

```sh
python3.11 -m pip install --dry-run --ignore-installed --only-binary=:all: \
  --report resolve.json --requirement requirements.seed.in
python3.11 freeze_lock.py --seed seed-manifest.json \
  --report resolve.json --output frozen-lock
python3.11 -m pip download --require-hashes --only-binary=:all: --no-deps \
  --dest wheelhouse --requirement frozen-lock/requirements.lock
```

The download command uses `--no-deps` only because every selected dependency must
already be an explicit hash-bound entry in the lock. It does not justify omitting
dependency checks. Verify every wheel against its selected filename, URL,
SHA-256 and target tag; reject extra wheels and missing entries. Inspect each
wheel's metadata and license, and preserve its declared dependencies. Freeze
the complete wheel list, model files, parent harness, input-page hashes and
configuration before building or producing OCR output.

Build from the recorded immutable base with a context containing only verified
inputs. The build must use `--platform=linux/amd64 --pull=false --network=none`.
Inside the build, perform the following offline installation and closure check;
the base's recorded Python and pip versions are part of the experiment:

```sh
python3.11 -m venv /opt/paddle
/opt/paddle/bin/python -m pip install --no-index --find-links=/wheelhouse \
  --require-hashes --only-binary=:all: --requirement /lock/requirements.lock
/opt/paddle/bin/python -m pip check
/opt/paddle/bin/python -m pip list --format=json
```

Hash and retain the installed package inventory, actual wheel set, full system
library inventory, image ID, ordered layers, configuration and build log. The
offline installation intentionally omits `--no-deps`: an omitted or incompatible
dependency must fail instead of being hidden by the preparation script. No
online package index or model repository is available to this build. The base,
complete lock, graph hashes and parent harness fields in the seed are currently
unset; therefore there is no ready-to-build image or runnable benchmark command.

## Frozen inference and resource requirements

The later harness must explicitly name the mobile detector and Arabic recognizer
and their immutable local directories. `lang='ar'` by itself selects a server
detector in the inspected source and is unsuitable as the candidate definition.
Explicitly select CPU and the `paddle_static` engine, one inference thread,
recognition batch size one, and disable document orientation, unwarping and text
line orientation. Record all effective settings and ensure no inherited medium
or server model remains active. Freeze one detector resize policy from the
official mobile configuration before output; verify how pipeline overrides
interact with its `resize_long: 960` rather than guessing. Do not tune dimensions
or thresholds against the observed pages. Preserve score threshold zero and all
returned lines, polygons and scores.

Use the existing maximum raster side of 2,000 pixels and include the actual Node
parent in the same 768 MiB, one-CPU, no-swap control group. The experiment first
measures cold initialization and the independently authored blank page under a
90-second attempt bound. Resource failure stops the experiment and is retained.
If it passes, process all six new pages and all seven unchanged historical
controls sequentially under the frozen per-page and campaign bounds. The
campaign bound and outer cleanup deadline must be recorded before execution;
the proposed thirteen-page attempt budget is at most 13 × 90 seconds, with cold
initialization/blank qualification recorded separately. This is a local
qualification schedule, not permission to exceed the existing production
CronJob's 600-second limit. Stop and mark unexecuted cases if the chosen campaign
bound expires; do not extend it after seeing a failure.

The reviewed upstream applies a bidirectional display transformation to returned
Arabic lines and sorts page boxes top to bottom, then left to right. Preserve
that returned sequence and compare it with independently frozen logical gold.
Do not relabel the returned strings as pre-transformation network output, reverse
them, reorder columns or repair identifiers from the expected answer. Runtime
adoption requires a versioned engine/provenance contract and separate source,
review, authorization and hosted checks; this build plan changes none of them.
