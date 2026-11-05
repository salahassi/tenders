# Paddle mobile experiment: dependency and offline build plan

The authorized November 5 preparation now has a target-specific **71-wheel
hash lock**, six verified model files and 65 verified Debian archives ready for
an offline image build. [The preparation receipt](evidence/arabic-paddle-build-preparation-20261105.json)
binds every input, exact base/interpreter, commands, logs, repository indexes and
cleanup. No package installation, native OCR import, recognition run, provider
call or production change occurred in this preparation. Installed dependency
closure, native compatibility, final image identity and resource fit remain
unverified. The six prospective gold pages are prepared and reviewed separately.

The source-only package is in
[`scripts/testing/paddle_candidate`](../scripts/testing/paddle_candidate/).
The original `seed-manifest.json` retains each official root-wheel URL, filename, version,
size, SHA-256 digest and published dependency declarations, including their
environment markers. `requirements.seed.in` is a resolver input, **not** an
installation lock. The actual full lock is
[`requirements-linux-x86_64-cp311-20261105.lock`](../scripts/testing/paddle_candidate/requirements-linux-x86_64-cp311-20261105.lock),
SHA-256 `91d74b353fd987540f6e0c1ea8c8e26078f980c16814d8ef75b908b14553df14`.
`freeze_lock.py` converted the target-native pip report into one hash per selected
wheel without importing an OCR package. Offline dependency closure remains
unverified. The converter refuses changed root pins, an incorrect target, source archives,
non-PyPI wheel hosts, missing hashes, duplicate/yanked packages and overwriting.

## Candidate pins and dependency closure

The candidate is CPython 3.11 on Linux x86-64 with glibc, PaddleOCR 3.7.0,
PaddleX 3.7.0 with only its `ocr-core` extra, PaddlePaddle 3.2.0 CPU and
`opencv-contrib-python` 4.10.0.84. The wheel hashes are already recorded in
[the feasibility evidence](evidence/arabic-paddle-feasibility-20261104.json).
The selected model repositories are:

- `PaddlePaddle/PP-OCRv5_mobile_det` at `0d63e78e2b680928f6b1747d76a08db6e645efb7`.
- `PaddlePaddle/arabic_PP-OCRv5_mobile_rec` at `33d91636a65dca87f5562cc48860332ae367ee1b`.

Both model cards declare Apache 2.0. The seed records the exact large-file SHA-256
digests and configuration-file hashes. Both graph files were downloaded from
their exact revisions and checked against the Git blob SHA-1 identity
(`SHA1("blob " + byte_count + NUL + bytes)`). The Arabic graph SHA-256 is
`d43832804d89c0e18d59f8446a3babd0ef60c44bc335efddac3176caf71d50af`; the detector
graph SHA-256 is `05feef1acb00aa4cd7362b15f7f501fc4f99d7b1fa73c1c871e0c7b1504b0f5c`.
All six files match their pinned sizes and hashes. Parameter bytes also match
the large-file SHA-256 and reconstructed Git LFS pointer identity. The original
seed's missing graph hashes remain a historical preparation state; use the
verified input manifest for the build. No mutable model URL or automatic runtime
download is allowed.

PaddleX unconditionally requires `aistudio-sdk`, `huggingface-hub`, `modelscope`,
NumPy, Pandas, Pillow, Pydantic and other packages. Its `ocr-core` extra adds
`imagesize`, OpenCV, `pyclipper`, `pypdfium2`, `python-bidi` and Shapely. PaddlePaddle
adds `httpx`, Protobuf, `opt-einsum==3.3.0`, NetworkX and SafeTensors. PaddleOCR
adds `aiohttp`, requests and typing extensions. PaddleX requires
`PyYAML==6.0.2`; NumPy's applicable intersection includes `>=1.24,<2.4`.
The original four package indexes could not establish transitive closure. The
target-native resolver subsequently selected 71 binary wheels with the fixed
candidate roots unchanged; all downloaded filenames, SHA-256 hashes and top-level
package names/versions match that lock. Offline installation and `pip check`
still must verify dependency closure. Omitting client libraries or using
`--no-deps` at installation would not establish a supported environment. Do not add the `all`,
`ocr`, training, GPU or high-performance extras to this candidate.

The downloaded 71-wheel set totals 340,238,500 compressed bytes and 1,162,198,456
ZIP-declared expanded bytes. Model runtime files add 13,070,333 bytes; the Debian
archives total 61,548,668 compressed bytes. Archive-member sizes are not an
installed footprint, disk reservation or memory requirement. A fresh check must include
all selected wheels, extraction, models, interpreter, Node parent, native system
libraries, package caches, image layers and the Docker storage driver. Host
`/tmp` is memory-backed; it is not interchangeable with workspace disk.

## Recorded preparation and remaining offline build

Resolution and download used
`docker.io/library/python:3.11-slim-bookworm@sha256:061c190f3d5815b341a18dfe8a45771f8ba68c15a607ea56997fde3009ac4eec`,
local image `sha256:65dc71ea3f90f9df522590028b8ee3e562f5e6b0d55c657f99ab71ad1426821c`.
It provides CPython 3.11.18, pip 24.0 and glibc 2.36 on Linux x86-64. Its complete
dpkg inventory is recorded. A separate disposable container downloaded the
authenticated Debian dependency closure for `poppler-utils`, `libgl1`,
`libglib2.0-0` and `libgomp1`; package versions, archive hashes, repository indexes
and signing-keyring hash are retained. Base dpkg state remained byte-identical.

The final offline image must combine this exact Python base, verified Debian
archives and the exact Node 24 binary/parent dependency closure prepared by the
coordinator. The existing Node base is pinned by `backend/deploy/Dockerfile.ocr`;
it alone does not supply the Python or Paddle/OpenCV libraries. Do not infer required
libraries from package names or install an unversioned apt set. Missing shared
libraries, glibc incompatibility or an unsupported CPU instruction are failures
to investigate, not grounds to substitute another engine silently.

The following resolver, lock and wheel-download commands completed inside that
exact target environment. Their command arrays and logs are retained. The
resolver also downloaded wheels to temporary files; it installed none. Reuse
these immutable outputs instead of repeating resolution against changing indexes:

```sh
python3.11 -m pip install --dry-run --ignore-installed --only-binary=:all: \
  --report resolve.json --requirement requirements.seed.in
python3.11 freeze_lock.py --seed seed-manifest.json \
  --report resolve.json --output frozen-lock
python3.11 -m pip download --require-hashes --only-binary=:all: --no-deps \
  --dest wheelhouse --requirement frozen-lock/requirements.lock
```

The download command used `--no-deps` only because every selected dependency must
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
online package index or model repository is available to this build. The new
`prepared-inputs.json` receipt supplies verified base, complete lock, graph and
archive hashes; the original seed remains unchanged. The final parent harness,
effective inference settings, immutable image and installed inventory must still
be frozen before any recognition. This preparation supplies no runnable or
approved OCR benchmark.

The first post-download metadata inspection stopped on setuptools' nested
vendored distribution metadata. The corrected inspection requires one top-level
distribution and inventories the vendored metadata separately. The initial
failure is retained; wheel bytes, versions and hashes did not change. Both
preparation containers exited successfully without out-of-memory termination
and were removed. Shared workspace disk observations include concurrent Node
base preparation and do not measure an isolated package footprint.

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

## Recorded offline assembly and pre-inference review

The preparation above has now produced an offline candidate image, with no
Paddle import or recognition yet. The exact image is
`sha256:2cf5d314540a69ca1eaeccbf7edc5fc6db48ec4047eb1405318d6406ce2969d5`
(1,706,755,238 logical bytes). Its closed 2,358-file build context has SHA-256
`ba9f19ad53190963d36bdc5098d5c3df83d1ec8f3cedd233f8045cece0049aea`.
[The assembly receipt](evidence/arabic-paddle-offline-assembly-20261105.json)
binds its ordered layers, configuration, commands, source snapshots, failures
and [installed metadata](evidence/arabic-paddle-offline-20261105/).

The image contains CPython 3.11.18, pip 24.0, glibc 2.36, the exact 71-wheel
lock, six model files and the staged Node 24.22.1 parent. Python dependency
checking, Debian package auditing, actual Node module import and UID/GID 1000
model/configuration/parent readability passed. No product function, default
Tesseract reader or customer/provider gateway was invoked during this build.

Three earlier assembly attempts remain failures in the record: local apt
archive resolution failed; the initial Node invocation omitted the production
TypeScript transformation flag; and direct checks of all ELF shared libraries
found unresolved helper names. The final assembly uses offline `dpkg` with
68 authenticated archives, including the additional `libsm6`, `libice6` and
`x11-common` closure. The wheel/model pins and recognition settings were not
changed. All 245 direct ELF inspections exited successfully. Twenty-one helper
checks still have their original unresolved-path output retained; narrowly
scoped checks against each wheel's own bundled library directory establish
dependency availability. These checks do not establish runtime loading:
`LD_LIBRARY_PATH` is not added to the runtime environment, and actual native
imports remain part of the first bounded blank attempt.

VFS disk behavior also stopped metadata extraction despite 2.624 GB free.
That never-started container was removed. The successful extraction used an
offline COPY-only scratch stage, with no RUN or container startup. Only exact
experiment-owned input-cache copies were removed, while all context paths and
hashes were preserved; identical copied Node/app files were deduplicated using
hardlinks. Root authorized removal of the unused public Node parent image after
zero container references were verified. Its immutable reference, original
inspection and extracted binary remain recorded, and the candidate and qualified
runtime images were retained. The campaign now requires at least
`max(4 GiB, 2 * actual image size + 512 MiB)` free before every creation.

The independently reviewed [campaign coordinator](../scripts/testing/paddle_candidate/CAMPAIGN.md)
freezes a separate 90-second cold blank, thirteen 90-second page attempts, a
1,170-second campaign wall deadline, 1,260 seconds of total work and a separate
cumulative 120-second cleanup allowance. Its absolute outer limit is 1,380
seconds. Each page uses a fresh container with the actual Node parent and Python
child in one 768 MiB, one-CPU, zero-swap cgroup. This measures fresh-process page
attempts; it does not qualify a persistent parent or cold operating-system cache.
Gold is never mounted or passed to either process. Raw upstream strings/order
and the Node newline-joined/trimmed projection are retained and scored separately
on the host using the frozen oracle.

Independent byte/source review found no remaining concrete preparation blocker.
Nineteen standard-library/mocked coordinator tests passed; they do not prove
Docker behavior, native compatibility, memory fit or recognition accuracy. At
this record's freeze, execution is still pending the required free disk, the
root coordinator's exact execution binding and an exclusive native window.
No OCR output exists, and neither resource fit nor quality is claimed.
